(defpackage :clide/base/inspector
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
                #:required-integer
                #:optional-string
                #:json-value
                #:json-array
                #:+slynk-failure+)
  (:export #:register-inspector-methods)
  (:documentation "The inspector: slynk's, for the ide methods."))

(in-package :clide/base/inspector)


;;; Code:
;;;
;;; Slynk keeps the inspector's state, a history of inspected objects.
;;; Each request below returns the object now shown, or null when there
;;; is none to show, as a JSON object:
;;;
;;;   {title, id, parts: [part], end, more}
;;;
;;; where a part is one of
;;;
;;;   {kind: "text", text}              plain text, newlines included
;;;   {kind: "label", text}             a field name
;;;   {kind: "value", text, index}      an object that can be inspected
;;;   {kind: "action", text, index}     something to do with the object
;;;
;;; and more says that ide/inspect/range can fetch more parts after end.
;;;
;;; Requests:
;;;
;;;   ide/inspect/init {code, package?}      inspect the value of code
;;;   ide/inspect/part {index}               inspect a value part
;;;   ide/inspect/pop                        back to the previous object
;;;   ide/inspect/next                       forward again
;;;   ide/inspect/reinspect                  refresh the current object
;;;   ide/inspect/toggleVerbose              print more or less
;;;   ide/inspect/range {from, to}           {parts, start, end, more}: more
;;;                                          parts of the same object
;;;   ide/inspect/action {index}             run an action part
;;;   ide/inspect/eval {code}                {text}: code with * as object
;;;   ide/inspect/describe {index?}          {text}: describe the object or
;;;                                          one of its parts
;;;   ide/inspect/quit                       forget the history
;;;   ide/inspect/frame {threadId, frame, code}
;;;   ide/inspect/frameVar {threadId, frame, var}
;;;   ide/inspect/condition {threadId}       from the debugger


;;; Content

(defun part-object (part)
  "Return the JSON object for PART, one element of slynk's content."
  (cond ((stringp part)
         (make-object "kind" "text" "text" part))
        ((and (consp part) (eq (first part) :label))
         (make-object "kind" "label" "text" (json-value (second part))))
        ((and (consp part) (eq (first part) :value))
         (make-object "kind" "value"
                      "text" (json-value (second part))
                      "index" (json-value (third part))))
        ((and (consp part) (eq (first part) :action))
         (make-object "kind" "action"
                      "text" (json-value (second part))
                      "index" (json-value (third part))))
        (t (make-object "kind" "text" "text" (json-value part)))))

(defun content-object (content)
  "Return the JSON object for CONTENT, what slynk's inspector calls
return: a plist with :TITLE, :ID and :CONTENT, the last being
\(PARTS NEXT START END), or NIL when there is nothing to show."
  (if (and (consp content) (getf content :content))
      (destructuring-bind (parts next start end) (getf content :content)
        (declare (ignore start))
        (make-object "title" (json-value (getf content :title))
                     "id" (json-value (getf content :id))
                     "parts" (json-array (mapcar #'part-object parts))
                     "end" (json-value end)
                     "more" (and (integerp next) (integerp end)
                                 (> next end))))
      'null))


;;; Requests

(defun call (ide form &key package (thread t))
  "Evaluate the wire FORM in slynk and return its value.  A failure is
a +SLYNK-FAILURE+ error."
  (let ((client (require-client ide)))
    (handler-case (client-call client form
                               :package package
                               :thread thread
                               :timeout 60)
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))

(defun inspect-call (ide name &rest args)
  "Call the inspector function NAME of slynk with ARGS and return the
JSON object for what it returns."
  (content-object (call ide (list* (sym name) args))))

(defun text-object (value)
  "Return the JSON object {text} for the string VALUE."
  (make-object "text" (json-value value)))

(defun init-inspector (ide params)
  "Handle ide/inspect/init: inspect the value of code."
  (content-object
   (call ide (list (sym "slynk:init-inspector")
                   (required-string params "code"))
         :package (optional-string params "package"))))

(defun inspect-part (ide params)
  "Handle ide/inspect/part: inspect a value part of the object."
  (inspect-call ide "slynk:inspect-nth-part"
                (required-integer params "index")))

(defun inspect-pop (ide params)
  "Handle ide/inspect/pop: go back to the previous object."
  (declare (ignore params))
  (inspect-call ide "slynk:inspector-pop"))

(defun inspect-next (ide params)
  "Handle ide/inspect/next: go forward again after a pop."
  (declare (ignore params))
  (inspect-call ide "slynk:inspector-next"))

(defun inspect-reinspect (ide params)
  "Handle ide/inspect/reinspect: refresh the current object."
  (declare (ignore params))
  (inspect-call ide "slynk:inspector-reinspect"))

(defun inspect-toggle-verbose (ide params)
  "Handle ide/inspect/toggleVerbose: print more or less of the object."
  (declare (ignore params))
  (inspect-call ide "slynk:inspector-toggle-verbose"))

(defun range-object (range)
  "Return the JSON object for RANGE, what slynk's inspector-range
returns: (PARTS NEXT START END)."
  (destructuring-bind (parts next start end) range
    (make-object "parts" (json-array (mapcar #'part-object parts))
                 "start" (json-value start)
                 "end" (json-value end)
                 "more" (and (integerp next) (integerp end)
                             (> next end)))))

(defun inspect-range (ide params)
  "Handle ide/inspect/range: parts from index from to index to.  The
reply is {parts, start, end, more}, without a title."
  (range-object
   (call ide (list (sym "slynk:inspector-range")
                   (required-integer params "from")
                   (required-integer params "to")))))

(defun inspect-action (ide params)
  "Handle ide/inspect/action: run an action part.  The reply is the
refreshed object, or null when the action asks for no refresh."
  (inspect-call ide "slynk:inspector-call-nth-action"
                (required-integer params "index")))

(defun inspect-eval (ide params)
  "Handle ide/inspect/eval: evaluate code with * bound to the object."
  (text-object
   (call ide (list (sym "slynk:inspector-eval")
                   (required-string params "code")))))

(defun inspect-describe (ide params)
  "Handle ide/inspect/describe: describe the object, or a part of it."
  (let ((index (and (hash-table-p params) (gethash "index" params))))
    (text-object
     (if (integerp index)
         (call ide (list (sym "slynk:describe-inspector-part") index))
         (call ide (list (sym "slynk:describe-inspectee")))))))

(defun inspect-quit (ide params)
  "Handle ide/inspect/quit: forget the history of inspected objects."
  (declare (ignore params))
  (call ide (list (sym "slynk:quit-inspector")))
  nil)

(defun inspect-frame (ide params)
  "Handle ide/inspect/frame: inspect the value of code in a frame."
  (content-object
   (call ide (list (sym "slynk:inspect-in-frame")
                   (required-string params "code")
                   (required-integer params "frame"))
         :thread (required-integer params "threadId"))))

(defun inspect-frame-var (ide params)
  "Handle ide/inspect/frameVar: inspect a local variable of a frame."
  (content-object
   (call ide (list (sym "slynk:inspect-frame-var")
                   (required-integer params "frame")
                   (required-integer params "var"))
         :thread (required-integer params "threadId"))))

(defun inspect-condition (ide params)
  "Handle ide/inspect/condition: inspect the condition being debugged."
  (content-object
   (call ide (list (sym "slynk:inspect-current-condition"))
         :thread (required-integer params "threadId"))))


;;; Registration

(defun register-inspector-methods (ide)
  "Register the ide/inspect/ methods on IDE, a value of
REGISTER-IDE-METHODS."
  (loop :for (name function)
          :in `(("ide/inspect/init" ,#'init-inspector)
                ("ide/inspect/part" ,#'inspect-part)
                ("ide/inspect/pop" ,#'inspect-pop)
                ("ide/inspect/next" ,#'inspect-next)
                ("ide/inspect/reinspect" ,#'inspect-reinspect)
                ("ide/inspect/toggleVerbose" ,#'inspect-toggle-verbose)
                ("ide/inspect/range" ,#'inspect-range)
                ("ide/inspect/action" ,#'inspect-action)
                ("ide/inspect/eval" ,#'inspect-eval)
                ("ide/inspect/describe" ,#'inspect-describe)
                ("ide/inspect/quit" ,#'inspect-quit)
                ("ide/inspect/frame" ,#'inspect-frame)
                ("ide/inspect/frameVar" ,#'inspect-frame-var)
                ("ide/inspect/condition" ,#'inspect-condition))
        :do (register-ide-method ide name function))
  ide)
