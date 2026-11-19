(defpackage :clide/base/compiler
  (:use :cl)
  (:import-from :clide/lib/jsonrpc
                #:make-object
                #:raise)
  (:import-from :clide/lib/slynk-wire
                #:sym)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:client-call-status)
  (:import-from :clide/base/ide
                #:ide
                #:require-client
                #:register-ide-method
                #:required-string
                #:required-integer
                #:optional-string
                #:json-value
                #:json-array
                #:+slynk-failure+)
  (:import-from :clide/base/location
                #:location-object)
  (:export #:register-compiler-methods)
  (:documentation "Compilation in a live image, for the ide methods."))

(in-package :clide/base/compiler)


;;; Code:
;;;
;;; Code that is compiled, unlike code that is evaluated, remembers
;;; where it came from: the debugger can open the source of a frame and
;;; the image can find the definition.  The compiler also reports what
;;; it thinks of the code.  Requests:
;;;
;;;   ide/compile {code, position, file?, package?}
;;;       compile and load the string CODE, which starts at the
;;;       character offset POSITION (from 0) of FILE, or of a buffer
;;;       with no file when FILE is absent
;;;   ide/compileFile {file, load?}
;;;       compile FILE, and load it when LOAD is true
;;;
;;; Both reply with
;;;
;;;   {ok, aborted, seconds, fasl, notes: [note]}
;;;
;;; where ok is the compiler's success, aborted is true when the user
;;; left a debugger that the loaded code entered, and a note is
;;;
;;;   {severity, message, context, location}
;;;
;;; with severity one of error, read-error, warning, style-warning,
;;; redefinition, note and the deprecation warnings, and location as in
;;; location.lisp; its file is null for code compiled from a buffer,
;;; which is the file asked about.  An error while loading enters the
;;; debugger, as with ide/eval, and the reply comes when it is left.

(defparameter *unsaved-buffer* "untitled"
  "The name of the buffer that code with no file is compiled from.")

(defun note-object (note)
  "Return the JSON object for NOTE, the plist of one compiler note."
  (make-object "severity" (json-value (getf note :severity))
               "message" (json-value (getf note :message))
               "context" (json-value (getf note :source-context))
               "location" (location-object (getf note :location))))

(defun result-object (result aborted)
  "Return the JSON object for RESULT, slynk's
(:COMPILATION-RESULT NOTES SUCCESSP DURATION LOADP FASLFILE), or for an
aborted compilation when ABORTED is true."
  (if aborted
      (make-object "ok" nil "aborted" t "seconds" 0 "fasl" 'null
                   "notes" (json-array nil))
      (destructuring-bind (kind notes successp duration &optional loadp fasl)
          result
        (declare (ignore kind loadp))
        (make-object "ok" (and successp t)
                     "aborted" nil
                     "seconds" (json-value duration)
                     "fasl" (json-value fasl)
                     "notes" (json-array (mapcar #'note-object notes))))))

(defun run-compilation (ide form package)
  "Evaluate the wire FORM, a call that compiles, and return the JSON
object for what it did."
  (let ((client (require-client ide)))
    (handler-case
        (multiple-value-bind (status value)
            (client-call-status client form :package package :timeout nil)
          (case status
            (:ok (result-object value nil))
            (:abort (result-object nil t))
            (t (raise +slynk-failure+ (format nil "~a" value)))))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))

(defun compile-string-form (code position file)
  "Return the wire form that compiles CODE, which starts at the offset
POSITION, counted from 0, of FILE.  Slynk counts positions from 1."
  (list (sym "slynk:compile-string-for-emacs")
        code
        (or file *unsaved-buffer*)
        (list (sym "quote") (list (list :position (1+ position))))
        file
        nil))

(defun compile-string (ide params)
  "Handle ide/compile: compile and load a string of code."
  (run-compilation ide
                   (compile-string-form (required-string params "code")
                                        (required-integer params "position")
                                        (optional-string params "file"))
                   (optional-string params "package")))

(defun compile-file-call (file load)
  "Return the wire form that compiles FILE, and loads it when LOAD."
  (list (sym "slynk:compile-file-for-emacs") file (and load t)))

(defun compile-source-file (ide params)
  "Handle ide/compileFile: compile a file, perhaps loading it."
  (run-compilation ide
                   (compile-file-call (required-string params "file")
                                      (eq (gethash "load" params) t))
                   nil))


;;; Registration

(defun register-compiler-methods (ide)
  "Register the compiler methods on IDE, a value of
REGISTER-IDE-METHODS."
  (loop :for (name function)
          :in `(("ide/compile" ,#'compile-string)
                ("ide/compileFile" ,#'compile-source-file))
        :do (register-ide-method ide name function))
  ide)
