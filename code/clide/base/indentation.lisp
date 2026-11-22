(defpackage :clide/base/indentation
  (:use :cl)
  (:import-from :bordeaux-threads
                #:make-lock
                #:with-lock-held)
  (:import-from :clide/lib/jsonrpc
                #:make-object)
  (:import-from :clide/lib/slynk-wire
                #:sym
                #:foreign-symbol-p
                #:foreign-symbol-name)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:client-call)
  (:import-from :clide/base/ide
                #:ide
                #:require-client
                #:require-module
                #:register-ide-method
                #:register-event-handler
                #:json-array
                #:notify)
  (:export #:register-indentation-methods
           #:spec-value
           #:rule-object)
  (:documentation "How slynk says macros are indented, for the editor."))

(in-package :clide/base/indentation)


;;; Code:
;;;
;;; Slynk's indentation contrib works out from the arglist of each macro
;;; how its calls are indented, and sends what it finds to the editor,
;;; for the macros the image has loaded; a user's macros are sent when
;;; the user's code is loaded, never before.  Requests:
;;;
;;;   ide/indentation    load the contrib, and have slynk send the rules
;;;                      of every macro it knows now and, as more code is
;;;                      loaded, of the new ones; returns {loaded}
;;;
;;; Notifications, sent to every client:
;;;
;;;   ide/indentation {rules: [{name, spec, packages}]}
;;;       name is the symbol, lower case; spec is how its calls are
;;;       indented, in the format of cl-indent: numbers, strings such as
;;;       "&body", null, and arrays of these; packages name the symbol.

(defparameter *chunk-size* 200
  "The most rules one notification carries.")

(defvar *load-lock* (make-lock "clide-indentation")
  "Held while the contrib is loaded, so it is loaded once.")


;;; Rules

(defun spec-value (spec)
  "Return SPEC, an indentation spec read from slynk, in a form JSON can
carry: numbers and strings stay, symbols become strings, NIL becomes
null and lists become arrays."
  (typecase spec
    (null 'null)
    (number spec)
    (string spec)
    (symbol (string-downcase (symbol-name spec)))
    (cons (json-array
           (loop :for rest = spec :then (cdr rest)
                 :while (consp rest)
                 :collect (spec-value (car rest)))))
    (t (if (foreign-symbol-p spec)
           (string-downcase (foreign-symbol-name spec))
           'null))))

(defun rule-object (entry)
  "Return the JSON object for ENTRY, a (NAME SPEC PACKAGES) list as
slynk sends it, or NIL when ENTRY is not one."
  (when (and (consp entry)
             (stringp (first entry))
             (consp (rest entry)))
    (make-object "name" (string-downcase (first entry))
                 "spec" (spec-value (second entry))
                 "packages" (json-array
                             (remove-if-not #'stringp (third entry))))))

(defun handle-indentation-update (ide event)
  "Handle EVENT, (:indentation-update ((NAME SPEC PACKAGES) ...)): tell
the clients, a chunk at a time since a full scan is large."
  (let ((rules (loop :for entry :in (and (listp (second event))
                                         (second event))
                     :for object = (ignore-errors (rule-object entry))
                     :when object
                       :collect object)))
    (loop :while rules
          :do (let ((chunk (loop :repeat *chunk-size*
                                 :while rules
                                 :collect (pop rules))))
                (notify ide "ide/indentation" "rules" (json-array chunk))))))


;;; Loading the contrib

(defun indentation-loaded-p (client)
  "Return true when the indentation contrib is loaded in the slynk of
CLIENT."
  (client-call client
               (list (sym "cl:and")
                     (list (sym "cl:member") "SLYNK/INDENTATION"
                           (sym "cl:*modules*")
                           :test (list (sym "cl:function")
                                       (sym "cl:string=")))
                     t)))

(defun ensure-indentation (client)
  "Load slynk's indentation contrib into the server of CLIENT unless it
is there, and return true when it is.  Slynk names it slynk/indentation
as an ASDF system and slynk-indentation through its own loader, so both
are tried."
  (with-lock-held (*load-lock*)
    (unless (indentation-loaded-p client)
      (dolist (module '("slynk/indentation" "slynk-indentation"))
        (require-module client module)
        (when (indentation-loaded-p client)
          (return))))
    (indentation-loaded-p client)))

(defun start-indentation (ide params)
  "Handle ide/indentation: load the contrib and ask slynk for every rule
it has.  The rules arrive as notifications.  A slynk without the contrib
is no failure; the answer is {loaded: false} and the editor keeps its
own table."
  (declare (ignore params))
  (let* ((client (require-client ide))
         (loaded (handler-case (ensure-indentation client)
                   (slynk-error () nil))))
    (when loaded
      (handler-case
          (client-call client
                       (list (sym "slynk::update-indentation-information")))
        (slynk-error () nil)))
    (make-object "loaded" (and loaded t))))


;;; Registration

(defun register-indentation-methods (hub)
  "Register the indentation method and event handler on HUB, a value of
REGISTER-IDE-METHODS."
  (register-event-handler hub :indentation-update #'handle-indentation-update)
  (register-ide-method hub "ide/indentation" #'start-indentation)
  hub)
