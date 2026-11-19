(defpackage :clide/base/language
  (:use :cl)
  (:import-from :clide/lib/jsonrpc
                #:make-object
                #:raise)
  (:import-from :clide/lib/slynk-wire
                #:sym)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:client-call)
  (:import-from :clide/base/ide
                #:ide
                #:require-client
                #:register-ide-method
                #:required-string
                #:optional-string
                #:optional-integer
                #:json-value
                #:json-array
                #:+slynk-failure+)
  (:import-from :clide/base/location
                #:location-object)
  (:export #:register-language-methods
           #:documentation-body)
  (:documentation "Language features of a live image: completion,
arglists, documentation and definitions, for the ide methods."))

(in-package :clide/base/language)


;;; Code:
;;;
;;; What the editor asks of the image while the user types.  Each
;;; request takes the package the code is read in, which jekyl finds
;;; from the nearest in-package form above the cursor:
;;;
;;;   ide/complete {prefix, package?, limit?}
;;;       {items: [{label, score, kind, chunks: [{start, text}]}]}
;;;       slynk's flex matching: "mvb" completes multiple-value-bind.
;;;       kind is slynk's classification, such as "fn" or "macro".
;;;   ide/arglist {name, package?}            {arglist}, a string or null
;;;   ide/documentation {name, package?}      {text}, a string or null
;;;   ide/definitions {name, package?}
;;;       {definitions: [{name, location}]}   location as in location.lisp
;;;       The image knows the definitions of what is loaded, no more.

(defparameter *default-limit* 100
  "How many completions ide/complete returns when asked for no number.")

(defun failure (condition)
  "Raise the +SLYNK-FAILURE+ error for the slynk CONDITION."
  (raise +slynk-failure+ (princ-to-string condition)))

(defun ask (ide params form)
  "Evaluate the wire FORM in slynk in the package PARAMS names and
return its value."
  (let ((client (require-client ide)))
    (handler-case
        (client-call client form
                     :package (optional-string params "package")
                     :timeout 30)
      (slynk-error (condition)
        (failure condition)))))


;;; Completion

(defun chunk-object (chunk)
  "Return the JSON object for CHUNK, (START TEXT): a run of characters
that the pattern matched."
  (make-object "start" (json-value (first chunk))
               "text" (json-value (second chunk))))

(defun completion-object (completion)
  "Return the JSON object for COMPLETION, slynk's
(STRING SCORE CHUNKS CLASSIFICATION)."
  (destructuring-bind (string score chunks classification) completion
    (make-object "label" (json-value string)
                 "score" (json-value score)
                 "kind" (json-value classification)
                 "chunks" (json-array (mapcar #'chunk-object chunks)))))

(defun complete (ide params)
  "Handle ide/complete: return the symbols that match a prefix."
  (let* ((prefix (required-string params "prefix"))
         (limit (or (optional-integer params "limit") *default-limit*))
         (result (ask ide params
                      (list (sym "slynk-completion:flex-completions")
                            prefix
                            (optional-string params "package")
                            :limit limit))))
    (make-object
     "items" (json-array (mapcar #'completion-object (first result))))))


;;; Documentation

(defun arglist (ide params)
  "Handle ide/arglist: return the lambda list of a function, printed."
  (let ((name (required-string params "name")))
    (make-object
     "arglist" (json-value
                (ask ide params
                     (list (sym "slynk:operator-arglist")
                           name
                           (optional-string params "package")))))))

(defun documentation-body (text)
  "Return TEXT, what slynk's documentation-symbol returns, without its
heading, or NIL when the symbol has no documentation or is unknown."
  (let ((start (search (format nil ":~%~%") text)))
    (when (and (stringp text)
               (eql 0 (search "Documentation for the symbol" text))
               start)
      (let ((body (string-trim '(#\Space #\Newline)
                               (subseq text (+ start 3)))))
        (unless (or (zerop (length body))
                    (string= body "Not documented."))
          body)))))

(defun documentation-text (ide params)
  "Handle ide/documentation: return the documentation of a symbol."
  (let ((name (required-string params "name")))
    (make-object
     "text" (json-value
             (documentation-body
              (ask ide params
                   (list (sym "slynk:documentation-symbol") name)))))))


;;; Definitions

(defun definition-object (definition)
  "Return the JSON object for DEFINITION, slynk's (DSPEC LOCATION)."
  (destructuring-bind (name location) definition
    (make-object "name" (json-value name)
                 "location" (location-object location))))

(defun definitions (ide params)
  "Handle ide/definitions: return where a name is defined."
  (let ((name (required-string params "name")))
    (make-object
     "definitions"
     (json-array
      (mapcar #'definition-object
              (let ((found (ask ide params
                                (list (sym "slynk:find-definitions-for-emacs")
                                      name))))
                (and (listp found) found)))))))


;;; Registration

(defun register-language-methods (ide)
  "Register the language methods on IDE, a value of
REGISTER-IDE-METHODS."
  (loop :for (name function)
          :in `(("ide/complete" ,#'complete)
                ("ide/arglist" ,#'arglist)
                ("ide/documentation" ,#'documentation-text)
                ("ide/definitions" ,#'definitions))
        :do (register-ide-method ide name function))
  ide)
