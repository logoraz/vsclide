(defpackage :clide/base/stickers
  (:use :cl)
  (:import-from :clide/lib/jsonrpc
                #:make-object
                #:raise
                #:+invalid-params+)
  (:import-from :clide/lib/slynk-wire
                #:sym)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:client-call
                #:client-call-status)
  (:import-from :clide/base/ide
                #:ide
                #:require-client
                #:ensure-stickers
                #:register-ide-method
                #:required-string
                #:required-integer
                #:optional-string
                #:optional-integer
                #:json-value
                #:json-array
                #:+slynk-failure+)
  (:import-from :clide/base/inspector
                #:content-object)
  (:import-from :clide/base/compiler
                #:result-object
                #:position-form
                #:*unsaved-buffer*)
  (:export #:register-sticker-methods
           #:sticker-object
           #:sticker-extra-object)
  (:documentation "Stickers and breakpoints in a live image: slynk's
stickers contrib, for the ide methods."))

(in-package :clide/base/stickers)


;;; Code:
;;;
;;; A sticker marks a form in source.  Compiling the form with the
;;; sticker makes the image record what the form returns each time it
;;; runs.  Which forms carry stickers is the editor's to know; the image
;;; only knows the numbers jekyl gives them.  A breakpoint is a sticker
;;; whose form enters the debugger before it runs.  Requests, all of
;;; which load the stickers contrib into the image when it is not there:
;;;
;;;   ide/stickers/compile {code, original?, position, file?, package?,
;;;                         stickers, dead?}
;;;       compile the string CODE, in which the forms of the STICKERS,
;;;       numbers, are already wrapped, as the text it starts at
;;;       POSITION (from 0) of FILE.  ORIGINAL, if
;;;       given, is the same text unwrapped, compiled when CODE does not
;;;       compile.  DEAD are stickers to forget.  Reply with
;;;       {stuck, result}: stuck is true when CODE was the one
;;;       compiled, and result is as for ide/compile, or null when
;;;       nothing compiled.
;;;   ide/stickers/kill {ids}
;;;   ide/stickers/fetch {dead?}
;;;       {stickers: [sticker]}, every sticker the image knows
;;;   ide/stickers/search {index, key?, ignored?, ignoreZombies?, dead?,
;;;                        sticker?, jump?}
;;;       move the playhead among the recordings by INDEX, or, with jump
;;;       true, to the recording at INDEX of all of them, or, with
;;;       sticker a number, to the INDEXth of that sticker's; reply with
;;;       {total, index, sticker} or {error}
;;;   ide/stickers/forget {dead?, howMany?}      {remaining}
;;;   ide/stickers/toggleBreak                   {on}
;;;   ide/stickers/inspect {sticker | recording, value?}
;;;       see ide/inspect/ for the reply
;;;
;;; with a sticker being
;;;
;;;   {id, count, recording}      recording null while it has none
;;;
;;; and a recording {id, time, values: [text], exited}, time being a
;;; universal time and exited true for a form left by a non-local exit.
;;; A debugger that a sticker enters says so in the condition of
;;; ide/debug/open, as {sticker: {kind, id, ...}}, where kind is
;;; "before", "after" or "breakpoint".

(defun id-list (params name)
  "Return the list of integers the array NAME of PARAMS holds."
  (let ((value (gethash name params)))
    (cond ((null value) nil)
          ((and (vectorp value) (every #'integerp value))
           (coerce value 'list))
          (t (raise +invalid-params+
                    (format nil "~a must be an array of integers." name))))))

(defun quoted (list)
  "Return the wire form that is LIST, unevaluated."
  (list (sym "quote") list))

(defun call (ide form &key package)
  "Evaluate the wire FORM in the image, which has the stickers by now,
and return its value.  A failure is a +SLYNK-FAILURE+ error."
  (let ((client (require-client ide)))
    (ensure-stickers ide client)
    (handler-case (client-call client form :package package :timeout 60)
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))


;;; Objects

(defun recording-object (id time values exited)
  "Return the JSON object for a recording."
  (make-object "id" (json-value id)
               "time" (json-value time)
               "values" (json-array (mapcar #'json-value values))
               "exited" (and exited t)))

(defun sticker-object (description)
  "Return the JSON object for DESCRIPTION, slynk's
(ID COUNT [RECORDING-ID TIME VALUES EXITED])."
  (destructuring-bind (id count &optional recording-id time values exited)
      description
    (make-object "id" (json-value id)
                 "count" (json-value count)
                 "recording" (if recording-id
                                 (recording-object recording-id time
                                                   values exited)
                                 'null))))

(defun sticker-extra-object (extras)
  "Return the JSON object for the sticker a debugger was entered for,
found in EXTRAS, the extra options of its condition, or NIL for a
debugger that has nothing to do with stickers."
  (dolist (extra extras)
    (when (consp extra)
      (case (first extra)
        (:slynk-before-sticker
         (return (make-object "kind" "before"
                              "id" (json-value (second extra)))))
        (:clide-breakpoint
         (return (make-object "kind" "breakpoint"
                              "id" (json-value (second extra)))))
        (:slynk-after-sticker
         (let ((object (sticker-object (second extra))))
           (setf (gethash "kind" object) "after")
           (return object)))))))


;;; Requests

(defun compile-stickered (ide params)
  "Handle ide/stickers/compile."
  (let* ((file (optional-string params "file"))
         (form (list (sym "slynk-stickers:compile-for-stickers")
                     (quoted (id-list params "stickers"))
                     (quoted (id-list params "dead"))
                     (required-string params "code")
                     (optional-string params "original")
                     (or file *unsaved-buffer*)
                     (position-form (required-integer params "position"))
                     file
                     nil))
         (client (require-client ide)))
    (ensure-stickers ide client)
    (handler-case
        (multiple-value-bind (status value)
            (client-call-status client form
                                :package (optional-string params "package")
                                :timeout nil)
          (case status
            (:ok (compile-reply value))
            (:abort (make-object "stuck" nil
                                 "result" (result-object nil t)))
            (t (raise +slynk-failure+ (format nil "~a" value)))))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))

(defun compile-reply (value)
  "Return the reply for VALUE, what compile-for-stickers returns: NIL,
or (RESULT STUCK), RESULT being a compilation result."
  (if (null value)
      (make-object "stuck" nil "result" 'null)
      (destructuring-bind (result stuck) value
        (make-object "stuck" (and stuck t)
                     "result" (result-object result nil)))))

(defun kill-stickers (ide params)
  "Handle ide/stickers/kill: forget stickers."
  (call ide (list (sym "slynk-stickers:kill-stickers")
                  (quoted (id-list params "ids"))))
  (make-object "ok" t))

(defun fetch-stickers (ide params)
  "Handle ide/stickers/fetch: describe every sticker."
  (let ((stickers
          (call ide (list (sym "slynk-stickers:fetch")
                          (quoted (id-list params "dead"))))))
    (make-object "stickers"
                 (json-array (mapcar #'sticker-object stickers)))))

(defun search-recordings (ide params)
  "Handle ide/stickers/search: move the playhead."
  (let* ((sticker (optional-integer params "sticker"))
         (command (cond (sticker sticker)
                        ((eq (gethash "jump" params) t) t)))
         (reply (call ide
                      (list (sym "slynk-stickers:search-for-recording")
                            (or (optional-integer params "key") 0)
                            (quoted (id-list params "ignored"))
                            (eq (gethash "ignoreZombies" params) t)
                            (quoted (id-list params "dead"))
                            (required-integer params "index")
                            command))))
    (if (null (first reply))
        (make-object "error" (json-value (second reply)))
        (destructuring-bind (total index &rest description) reply
          (make-object "total" total
                       "index" index
                       "sticker" (sticker-object description))))))

(defun forget-recordings (ide params)
  "Handle ide/stickers/forget: drop the recordings."
  (let ((how-many (optional-integer params "howMany")))
    (make-object
     "remaining"
     (call ide (list* (sym "slynk-stickers:forget")
                      (quoted (id-list params "dead"))
                      (and how-many (list how-many)))))))

(defun toggle-break (ide params)
  "Handle ide/stickers/toggleBreak: break on every sticker, or stop."
  (declare (ignore params))
  (make-object
   "on" (and (call ide (list (sym "slynk-stickers:toggle-break-on-stickers")))
             t)))

(defun inspect-sticker (ide params)
  "Handle ide/stickers/inspect: inspect a sticker, or a recording, or
the value of one, in the inspector."
  (let ((sticker (optional-integer params "sticker"))
        (recording (optional-integer params "recording")))
    (cond (sticker
           (inspect-content
            ide (list (sym "slynk-stickers:inspect-sticker") sticker)))
          (recording
           (inspect-content
            ide (list (sym "slynk-stickers:inspect-sticker-recording")
                      recording
                      (optional-integer params "value"))))
          (t (raise +invalid-params+ "give a sticker or a recording.")))))

(defun inspect-content (ide form)
  "Return the inspector content for what the wire FORM inspects."
  (content-object (call ide form)))


;;; Registration

(defun register-sticker-methods (hub)
  "Register the ide/stickers/ methods on HUB, a value of
REGISTER-IDE-METHODS."
  (loop :for (name function)
          :in `(("ide/stickers/compile" ,#'compile-stickered)
                ("ide/stickers/kill" ,#'kill-stickers)
                ("ide/stickers/fetch" ,#'fetch-stickers)
                ("ide/stickers/search" ,#'search-recordings)
                ("ide/stickers/forget" ,#'forget-recordings)
                ("ide/stickers/toggleBreak" ,#'toggle-break)
                ("ide/stickers/inspect" ,#'inspect-sticker))
        :do (register-ide-method hub name function))
  hub)
