(defpackage :clide/base/debugger
  (:use :cl)
  (:import-from :clide/lib/jsonrpc
                #:make-object
                #:raise
                #:+invalid-params+)
  (:import-from :clide/lib/slynk-wire
                #:sym)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:client-rex
                #:client-call
                #:client-call-status)
  (:import-from :clide/base/location
                #:location-object)
  (:import-from :clide/base/ide
                #:ide
                #:require-client
                #:register-ide-method
                #:register-event-handler
                #:required-string
                #:required-integer
                #:optional-string
                #:optional-integer
                #:json-value
                #:json-array
                #:notify
                #:+slynk-failure+)
  (:export #:register-debugger-methods)
  (:documentation "The debugger: slynk's sldb, for the ide methods."))

(in-package :clide/base/debugger)


;;; Code:
;;;
;;; When a thread in the slynk image enters the debugger, slynk sends
;;; :DEBUG with the thread, the level, the condition, the restarts and
;;; the first frames, and then :DEBUG-ACTIVATE.  Every request that
;;; belongs to that debugger goes to that thread, so each takes a
;;; threadId.  The notifications:
;;;
;;;   ide/debug/open {threadId, level, condition: {message, type},
;;;                   restarts: [{name, description}],
;;;                   frames: [{index, text, restartable}]}
;;;   ide/debug/activate {threadId, level}
;;;   ide/debug/return {threadId, level, stepping}
;;;   ide/debug/condition {threadId, message}   debugger's own error
;;;
;;; The requests, all with threadId unless said:
;;;
;;;   ide/debug/backtrace {start, end?}       {frames}
;;;   ide/debug/frame {frame}                 {locals, catchTags, package,
;;;                                            location}
;;;   ide/debug/restart {level, index}        invoke a restart
;;;   ide/debug/abort                         return to the previous level
;;;   ide/debug/quit                          return to top level
;;;   ide/debug/continue
;;;   ide/debug/eval {frame, code, package?, pprint?}   {ok, text}
;;;   ide/debug/step {frame, kind}            kind is into, next or out
;;;   ide/debug/returnFrom {frame, code}      return code's value from it
;;;   ide/debug/restartFrame {frame}
;;;   ide/debug/breakOnSignals                no threadId; {message}
;;;
;;; The requests that leave the debugger, such as a restart, are
;;; answered at once; slynk reports the result as notifications.


;;; Notifications

(defun frame-object (frame)
  "Return the JSON object for FRAME, slynk's (INDEX TEXT [PLIST])."
  (destructuring-bind (index text &optional plist) frame
    (make-object "index" index
                 "text" (json-value text)
                 "restartable" (and (listp plist)
                                    (eq (getf plist :restartable) t)))))

(defun frames-array (frames)
  "Return the JSON array for FRAMES."
  (json-array (mapcar #'frame-object frames)))

(defun restart-object (restart)
  "Return the JSON object for RESTART, slynk's (NAME DESCRIPTION)."
  (destructuring-bind (name description) restart
    (make-object "name" (json-value name)
                 "description" (json-value description))))

(defun condition-object (condition)
  "Return the JSON object for CONDITION, slynk's (MESSAGE TYPE [EXTRA])."
  (make-object "message" (json-value (first condition))
               "type" (json-value (second condition))))

(defun handle-debug (ide event)
  "Turn the :DEBUG EVENT into ide/debug/open."
  (destructuring-bind (thread level condition restarts frames &rest more)
      (rest event)
    (declare (ignore more))
    (notify ide "ide/debug/open"
            "threadId" (json-value thread)
            "level" (json-value level)
            "condition" (condition-object condition)
            "restarts" (json-array (mapcar #'restart-object restarts))
            "frames" (frames-array frames))))

(defun handle-debug-activate (ide event)
  "Turn the :DEBUG-ACTIVATE EVENT into ide/debug/activate."
  (destructuring-bind (thread level &rest more) (rest event)
    (declare (ignore more))
    (notify ide "ide/debug/activate"
            "threadId" (json-value thread)
            "level" (json-value level))))

(defun handle-debug-return (ide event)
  "Turn the :DEBUG-RETURN EVENT into ide/debug/return."
  (destructuring-bind (thread level &optional stepping) (rest event)
    (notify ide "ide/debug/return"
            "threadId" (json-value thread)
            "level" (json-value level)
            "stepping" (and stepping t))))

(defun handle-debug-condition (ide event)
  "Turn the :DEBUG-CONDITION EVENT into ide/debug/condition."
  (destructuring-bind (thread message &rest more) (rest event)
    (declare (ignore more))
    (notify ide "ide/debug/condition"
            "threadId" (json-value thread)
            "message" (json-value message))))


;;; Requests

(defun thread-param (params)
  "Return the threadId parameter, the thread that is in the debugger."
  (required-integer params "threadId"))

(defun call-in-thread (ide params form &key package)
  "Evaluate the wire FORM in the debugger thread named by PARAMS and
return its value.  A failure is a +SLYNK-FAILURE+ error."
  (let ((client (require-client ide)))
    (handler-case
        (client-call client form
                     :thread (thread-param params)
                     :package package
                     :timeout 60)
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))

(defun fire (ide params form)
  "Send the wire FORM to the debugger thread named by PARAMS without
waiting.  The calls that use this end the debugger level, so slynk
answers them with an abort or not at all; the notifications tell what
came of them."
  (let ((client (require-client ide)))
    (handler-case
        (client-rex client form
                    (lambda (status value)
                      (declare (ignore status value))
                      nil)
                    :thread (thread-param params))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))
    nil))

(defun backtrace (ide params)
  "Handle ide/debug/backtrace: return frames from start to end."
  (let ((start (required-integer params "start"))
        (end (optional-integer params "end")))
    (make-object
     "frames"
     (frames-array
      (call-in-thread ide params
                      (list (sym "slynk:backtrace") start end))))))

(defun local-object (local)
  "Return the JSON object for LOCAL, a plist with :NAME, :ID and :VALUE."
  (make-object "name" (json-value (getf local :name))
               "id" (json-value (getf local :id))
               "value" (json-value (getf local :value))))

(defun frame-details (ide params)
  "Handle ide/debug/frame: return locals, catch tags, package and the
source location of a frame."
  (let ((frame (required-integer params "frame")))
    (destructuring-bind (locals tags)
        (call-in-thread ide params
                        (list (sym "slynk:frame-locals-and-catch-tags")
                              frame))
      (make-object
       "locals" (json-array (mapcar #'local-object locals))
       "catchTags" (json-array (mapcar #'json-value tags))
       "package" (json-value
                  (call-in-thread
                   ide params
                   (list (sym "slynk:frame-package-name") frame)))
       "location" (location-object
                   (call-in-thread
                    ide params
                    (list (sym "slynk:frame-source-location") frame)))))))

(defun invoke-level-restart (ide params)
  "Handle ide/debug/restart: invoke restart number index of the level."
  (fire ide params
        (list (sym "slynk:invoke-nth-restart-for-emacs")
              (required-integer params "level")
              (required-integer params "index"))))

(defun abort-level (ide params)
  "Handle ide/debug/abort: return to the previous debugger level."
  (fire ide params (list (sym "slynk:sly-db-abort"))))

(defun quit-to-top (ide params)
  "Handle ide/debug/quit: abandon the evaluation, whatever the level."
  (fire ide params (list (sym "slynk:throw-to-toplevel"))))

(defun continue-from (ide params)
  "Handle ide/debug/continue: use the continue restart."
  (fire ide params (list (sym "slynk:sly-db-continue"))))

(defun eval-in-frame (ide params)
  "Handle ide/debug/eval: evaluate code in a frame and return the
printed values.  A nested debugger or a Lisp error is a reply with ok
false."
  (let ((frame (required-integer params "frame"))
        (code (required-string params "code"))
        (package (or (optional-string params "package") "COMMON-LISP-USER"))
        (function (if (eq (gethash "pprint" params) t)
                      "slynk:pprint-eval-string-in-frame"
                      "slynk:eval-string-in-frame"))
        (client (require-client ide)))
    (handler-case
        (multiple-value-bind (status value)
            (client-call-status client
                                (list (sym function) code frame package)
                                :thread (thread-param params)
                                :timeout nil)
          (case status
            (:ok (make-object "ok" t "text" (json-value value)))
            (:abort (make-object "ok" nil "text" (json-value value)))
            (t (raise +slynk-failure+ (format nil "~a" value)))))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))

(defun step-frame (ide params)
  "Handle ide/debug/step: step into, over (next) or out of a frame."
  (let ((function
          (cond ((equal (param-kind params) "into") "slynk:sly-db-step")
                ((equal (param-kind params) "next") "slynk:sly-db-next")
                ((equal (param-kind params) "out") "slynk:sly-db-out")
                (t (raise +invalid-params+
                          "kind must be into, next or out.")))))
    (fire ide params (list (sym function) (required-integer params "frame")))))

(defun param-kind (params)
  "Return the kind parameter, a string, or NIL."
  (optional-string params "kind"))

(defun return-from-frame (ide params)
  "Handle ide/debug/returnFrom: return the value of code from a frame."
  (fire ide params
        (list (sym "slynk:sly-db-return-from-frame")
              (required-integer params "frame")
              (required-string params "code"))))

(defun restart-frame (ide params)
  "Handle ide/debug/restartFrame: run a frame again from its start."
  (fire ide params
        (list (sym "slynk:restart-frame") (required-integer params "frame"))))

(defun break-on-signals (ide params)
  "Handle ide/debug/breakOnSignals: toggle *break-on-signals* and say
what it is now."
  (declare (ignore params))
  (let ((client (require-client ide)))
    (handler-case
        (make-object
         "message" (json-value
                    (client-call client
                                 (list (sym "slynk:toggle-break-on-signals")))))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))


;;; Registration

(defun register-debugger-methods (ide)
  "Register the ide/debug/ methods and the debugger event handlers on
IDE, a value of REGISTER-IDE-METHODS."
  (register-event-handler ide :debug #'handle-debug)
  (register-event-handler ide :debug-activate #'handle-debug-activate)
  (register-event-handler ide :debug-return #'handle-debug-return)
  (register-event-handler ide :debug-condition #'handle-debug-condition)
  (loop :for (name function)
          :in `(("ide/debug/backtrace" ,#'backtrace)
                ("ide/debug/frame" ,#'frame-details)
                ("ide/debug/restart" ,#'invoke-level-restart)
                ("ide/debug/abort" ,#'abort-level)
                ("ide/debug/quit" ,#'quit-to-top)
                ("ide/debug/continue" ,#'continue-from)
                ("ide/debug/eval" ,#'eval-in-frame)
                ("ide/debug/step" ,#'step-frame)
                ("ide/debug/returnFrom" ,#'return-from-frame)
                ("ide/debug/restartFrame" ,#'restart-frame)
                ("ide/debug/breakOnSignals" ,#'break-on-signals))
        :do (register-ide-method ide name function))
  ide)
