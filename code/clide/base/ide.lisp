(defpackage :clide/base/ide
  (:use :cl)
  (:import-from :bordeaux-threads
                #:make-lock
                #:with-lock-held)
  (:import-from :clide/lib/jsonrpc
                #:make-object
                #:raise
                #:+invalid-params+)
  (:import-from :clide/lib/slynk-wire
                #:sym
                #:foreign-symbol-p
                #:foreign-symbol-name)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:connect-client
                #:close-client
                #:client-open-p
                #:client-rex
                #:client-call
                #:client-call-status
                #:client-interrupt
                #:open-channel
                #:close-channel
                #:channel-send)
  (:import-from :clide/base/server
                #:register-method
                #:broadcast)
  (:export #:register-ide-methods
           #:+not-connected+
           #:+slynk-failure+
           ;; For the modules that add methods
           #:ide
           #:ide-server
           #:require-client
           #:find-repl
           #:repl-server-id
           #:repl-thread-id
           #:register-ide-method
           #:register-event-handler
           #:param
           #:required-string
           #:optional-string
           #:required-integer
           #:optional-integer
           #:json-value
           #:json-array
           #:notify)
  (:documentation "IDE methods: connect to slynk, evaluate, REPLs."))

(in-package :clide/base/ide)


;;; Code:
;;;
;;; The methods registered here are what jekyl calls.  Requests:
;;;
;;;   ide/connect {host?, port}          connect, return implementation info
;;;   ide/disconnect                     drop the connection
;;;   ide/eval {code, package?, debug?}  evaluate, return output and value;
;;;                                      with debug, an error enters the
;;;                                      debugger and the call returns when
;;;                                      the debugger is left
;;;   ide/sylvesters                     {text}: slynk's sylvesters.txt, or null
;;;   ide/repl/create                    new REPL, return its id
;;;   ide/repl/send {replId, text}       give a REPL a line of input
;;;   ide/repl/interrupt {replId}        interrupt a running REPL evaluation
;;;   ide/repl/close {replId}            end a REPL
;;;
;;; Notifications, sent to every client:
;;;
;;;   ide/disconnected {reason}          the slynk connection ended
;;;   ide/output {text}                  output with no REPL to take it
;;;   ide/repl/output {replId, text}
;;;   ide/repl/prompt {replId, package, nickname, level, entry, condition}
;;;   ide/repl/values {replId, values: [{text, index, value}]}
;;;   ide/repl/aborted {replId, message}
;;;   ide/repl/readMode {replId, mode}
;;;   ide/repl/cleared {replId}
;;;
;;; Notifications for a REPL can arrive before the reply to
;;; ide/repl/create that tells the caller its id.

(defconstant +not-connected+ -32002
  "No slynk connection is open.")

(defconstant +slynk-failure+ -32003
  "Slynk could not be reached or refused the request.")

(defstruct (ide (:constructor make-ide (server)))
  "Everything the IDE methods share: the server to notify, the slynk
connection and the REPLs open on it."
  server
  (lock (make-lock "clide-ide"))
  (load-lock (make-lock "clide-ide-load"))
  (client nil)
  (repls (make-hash-table) :type hash-table)
  (handlers (make-hash-table) :type hash-table))

(defstruct (repl (:constructor make-repl (server-id thread-id)))
  "A REPL: the slynk channel and thread behind a client side id."
  server-id
  thread-id)


;;; Parameters and JSON

(defun param (params name)
  "Return the value of NAME in the JSON object PARAMS, or NIL."
  (and (hash-table-p params)
       (values (gethash name params))))

(defun required-string (params name)
  "Return the string parameter NAME, or raise +INVALID-PARAMS+."
  (let ((value (param params name)))
    (if (stringp value)
        value
        (raise +invalid-params+ (format nil "~a must be a string." name)))))

(defun optional-string (params name)
  "Return the string parameter NAME, or NIL when absent or not a string."
  (let ((value (param params name)))
    (and (stringp value) value)))

(defun required-integer (params name)
  "Return the integer parameter NAME, or raise +INVALID-PARAMS+."
  (let ((value (param params name)))
    (if (integerp value)
        value
        (raise +invalid-params+ (format nil "~a must be an integer." name)))))

(defun optional-integer (params name)
  "Return the integer parameter NAME, or NIL when absent or not an
integer."
  (let ((value (param params name)))
    (and (integerp value) value)))

(defun json-value (value)
  "Return VALUE, read from slynk, in a form JSON can carry."
  (typecase value
    (null 'null)
    (string value)
    (number value)
    (keyword (string-downcase (symbol-name value)))
    (symbol (string-downcase (symbol-name value)))
    (t (if (foreign-symbol-p value)
           (foreign-symbol-name value)
           (princ-to-string value)))))

(defun json-array (list)
  "Return LIST as a vector, which JSON writes as an array even if empty."
  (coerce list 'simple-vector))

(defun notify (ide method &rest pairs)
  "Notify every client of METHOD with an object made from PAIRS."
  (broadcast (ide-server ide) method (apply #'make-object pairs)))


;;; Connection

(defun require-client (ide)
  "Return the open slynk client of IDE, or raise +NOT-CONNECTED+."
  (let ((client (with-lock-held ((ide-lock ide))
                  (ide-client ide))))
    (if (and client (client-open-p client))
        client
        (raise +not-connected+ "Not connected to slynk."))))

(defun connection-info-object (info)
  "Return the JSON object describing the plist INFO that slynk's
connection-info call returns."
  (flet ((field (plist key)
           (json-value (getf plist key))))
    (let ((implementation (getf info :lisp-implementation))
          (machine (getf info :machine))
          (package (getf info :package)))
      (make-object
       "implementation" (make-object
                         "type" (field implementation :type)
                         "name" (field implementation :name)
                         "version" (field implementation :version)
                         "program" (field implementation :program))
       "pid" (field info :pid)
       "style" (field info :style)
       "machine" (make-object "instance" (field machine :instance)
                              "type" (field machine :type)
                              "version" (field machine :version))
       "package" (make-object "name" (field package :name)
                              "prompt" (field package :prompt))
       "protocolVersion" (field info :version)))))

(defun abort-debugger (client event)
  "Leave the debugger that slynk entered, as announced by EVENT.
Nobody can answer a debugger yet, and the thread would wait for ever."
  (let ((thread (second event)))
    (ignore-errors
     (client-rex client
                 (list (sym "slynk:throw-to-toplevel"))
                 (lambda (status value)
                   (declare (ignore status value))
                   nil)
                 :thread thread))))

(defun connection-closed (ide client reason)
  "Forget CLIENT if it is still the current connection and tell jekyl."
  (let ((current (with-lock-held ((ide-lock ide))
                   (when (eq client (ide-client ide))
                     (setf (ide-client ide) nil)
                     (clrhash (ide-repls ide))
                     t))))
    (when current
      (notify ide "ide/disconnected" "reason" reason))))

(defun register-event-handler (ide kind function)
  "Have FUNCTION handle the slynk events of KIND, a keyword.  It is
called in the reader thread with IDE and the event, and must not block."
  (setf (gethash kind (ide-handlers ide)) function))

(defun handle-event (ide client event)
  "Handle a slynk message that belongs to no call or channel.  A
debugger event that nobody handles is aborted, since the thread that
entered the debugger would wait for ever."
  (let ((handler (gethash (first event) (ide-handlers ide))))
    (cond (handler (funcall handler ide event))
          ((eq (first event) :closed)
           (connection-closed ide client (second event)))
          ((eq (first event) :write-string)
           (when (stringp (second event))
             (notify ide "ide/output" "text" (second event))))
          ((eq (first event) :debug) (abort-debugger client event))
          (t nil))))

(defun disconnect (ide)
  "Close the slynk connection of IDE, if any, without a notification."
  (let ((client (with-lock-held ((ide-lock ide))
                  (prog1 (ide-client ide)
                    (setf (ide-client ide) nil)
                    (clrhash (ide-repls ide))))))
    (when client
      (close-client client))))

(defun connect (ide params)
  "Handle ide/connect: open a connection and return implementation info."
  (let ((host (or (optional-string params "host") "127.0.0.1"))
        (port (required-integer params "port")))
    (disconnect ide)
    (let ((client (handler-case
                      (connect-client
                       host port
                       :event-fn (lambda (client event)
                                   (handle-event ide client event)))
                    (error (condition)
                      (raise +slynk-failure+
                             (format nil "Cannot connect to slynk on ~a:~d: ~a"
                                     host port condition))))))
      (handler-case
          (let ((info (client-call client
                                   (list (sym "slynk:connection-info")))))
            (with-lock-held ((ide-lock ide))
              (setf (ide-client ide) client))
            (connection-info-object info))
        (slynk-error (condition)
          (close-client client)
          (raise +slynk-failure+
                 (format nil "Slynk did not answer: ~a" condition)))))))


;;; Evaluation

(defun eval-form (code)
  "Return the wire form that evaluates the string CODE in slynk.
Errors are caught on the server, so no debugger is entered; the form
returns (:error TEXT) after one, else (OUTPUT VALUE-TEXT).  Numbers
print plain, without the bit counts and radixes slynk adds for an echo
area."
  (list (sym "cl:let")
        (list (list (sym "slynk::*echo-number-alist*") nil))
        (list (sym "cl:handler-case")
              (list (sym "slynk:eval-and-grab-output") code)
              (list (sym "cl:serious-condition")
                    (list (sym "c"))
                    (list (sym "cl:list") :error
                          (list (sym "cl:princ-to-string") (sym "c")))))))

(defun debug-eval-form (code)
  "Return the wire form that evaluates the string CODE in slynk with
the debugger enabled: an error enters it, as in SLY.  The form returns
(OUTPUT VALUE-TEXT), numbers printed plain."
  (list (sym "cl:let")
        (list (list (sym "slynk::*echo-number-alist*") nil))
        (list (sym "slynk:eval-and-grab-output") code)))

(defun eval-result-object (result)
  "Return the JSON object for RESULT, what EVAL-FORM's form returned."
  (if (and (consp result) (eq (first result) :error))
      (make-object "ok" nil
                   "error" (json-value (second result))
                   "output" ""
                   "value" 'null)
      (make-object "ok" t
                   "error" 'null
                   "output" (json-value (first result))
                   "value" (json-value (second result)))))

(defun evaluate (ide params)
  "Handle ide/eval: evaluate code in slynk and return what it printed
and the printed value.  A Lisp error is a normal reply with ok false.
With the debug parameter an error enters the debugger instead and the
call returns when the debugger is left, ok false with slynk's message."
  (let ((code (required-string params "code"))
        (package (optional-string params "package"))
        (debug (param params "debug"))
        (client (require-client ide)))
    (handler-case
        (if (eq debug t)
            (debug-evaluate client code package)
            (eval-result-object
             (client-call client (eval-form code)
                          :package package
                          :timeout nil)))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))

(defun debug-evaluate (client code package)
  "Evaluate CODE on CLIENT with the debugger enabled.  Leaving the
debugger by an abort ends the evaluation; that is a reply with ok false,
not a failure, unless the connection itself is gone."
  (multiple-value-bind (status value)
      (client-call-status client (debug-eval-form code)
                          :package package :timeout nil)
    (case status
      (:ok (eval-result-object value))
      (:abort (make-object "ok" nil
                           "error" (json-value value)
                           "output" ""
                           "value" 'null))
      (t (error 'slynk-error
                :message (format nil "~a" value))))))

(defun sylvesters-form ()
  "Return the form that reads sylvesters.txt in the slynk image.  The
file sits in the contrib directory next to the slynk system, and is
read from the user's own install, never copied.  Evaluates to the
text, or NIL when the file cannot be found."
  (list (sym "cl:ignore-errors")
        (list (sym "cl:with-open-file")
              (list (sym "s")
                    (list (sym "cl:merge-pathnames")
                          "../contrib/sylvesters.txt"
                          (list (sym "asdf:system-source-directory")
                                "slynk"))
                    :external-format :utf-8)
              (list (sym "cl:let")
                    (list (list (sym "text")
                                (list (sym "cl:make-string")
                                      (list (sym "cl:file-length")
                                            (sym "s")))))
                    (list (sym "cl:subseq")
                          (sym "text")
                          0
                          (list (sym "cl:read-sequence")
                                (sym "text")
                                (sym "s")))))))

(defun sylvesters (ide params)
  "Handle ide/sylvesters: return the text of slynk's sylvesters.txt, or
null when this slynk install has none."
  (declare (ignore params))
  (let ((text (handler-case
                  (client-call (require-client ide) (sylvesters-form))
                (slynk-error () nil))))
    (make-object "text" (if (stringp text) text 'null))))


;;; REPLs

(defun mrepl-loaded-p (client)
  "Return true when the mrepl contrib is loaded in the slynk of CLIENT."
  (client-call client
               (list (sym "cl:and")
                     (list (sym "cl:find-package") "SLYNK-MREPL")
                     t)))

(defun require-module (client module)
  "Ask slynk to load MODULE, ignoring failure; the caller checks."
  (handler-case
      (client-call client
                   (list (sym "slynk:slynk-require")
                         (list (sym "quote") (list module)))
                   :timeout 300)
    (slynk-error () nil)))

(defun ensure-mrepl (ide client)
  "Load slynk's mrepl contrib into the server of CLIENT unless it is
there.  Slynk names it slynk/mrepl as an ASDF system and slynk-mrepl
through its own loader, so both are tried."
  (with-lock-held ((ide-load-lock ide))
    (unless (mrepl-loaded-p client)
      (dolist (module '("slynk/mrepl" "slynk-mrepl"))
        (require-module client module)
        (when (mrepl-loaded-p client)
          (return)))
      (unless (mrepl-loaded-p client)
        (raise +slynk-failure+
               "Slynk could not load the mrepl contrib.")))))

(defun notify-repl (ide id method &rest pairs)
  "Notify clients of METHOD for REPL ID, with extra PAIRS."
  (apply #'notify ide method "replId" id pairs))

(defun repl-values-array (values)
  "Return the JSON array for the :write-values payload VALUES, a list
of (TEXT ENTRY-INDEX SHORT-TEXT).  Each element has the printed text,
the history entry it belongs to (index), and its place among the values
of that entry (value), which together name it for ide/inspect/replValue."
  (json-array
   (loop :for entry :in values
         :for position :from 0
         :collect (make-object "text" (json-value (first entry))
                               "index" (json-value (second entry))
                               "value" position))))

(defun handle-repl-message (ide id selector args)
  "Turn the message SELECTOR with ARGS for REPL ID into a notification."
  (case selector
    (:write-string
     (notify-repl ide id "ide/repl/output" "text" (json-value (first args))))
    (:prompt
     (destructuring-bind (package nickname level entry &optional condition)
         args
       (notify-repl ide id "ide/repl/prompt"
                    "package" (json-value package)
                    "nickname" (json-value nickname)
                    "level" (json-value level)
                    "entry" (json-value entry)
                    "condition" (json-value condition))))
    (:write-values
     (notify-repl ide id "ide/repl/values"
                  "values" (repl-values-array (first args))))
    (:evaluation-aborted
     (notify-repl ide id "ide/repl/aborted"
                  "message" (json-value (first args))))
    (:set-read-mode
     (notify-repl ide id "ide/repl/readMode"
                  "mode" (json-value (first args))))
    (:clear-repl-history
     (notify-repl ide id "ide/repl/cleared"))
    (t nil)))

(defun find-repl (ide params)
  "Return the REPL named by the replId parameter, or raise."
  (let* ((id (required-integer params "replId"))
         (repl (with-lock-held ((ide-lock ide))
                 (gethash id (ide-repls ide)))))
    (or repl
        (raise +invalid-params+ (format nil "No REPL ~d." id)))))

(defun create-repl (ide params)
  "Handle ide/repl/create: open a REPL on the slynk server and return
its id.  The first prompt arrives as a notification."
  (declare (ignore params))
  (let ((client (require-client ide)))
    (ensure-mrepl ide client)
    (let* ((id nil)
           (channel (open-channel
                     client
                     (lambda (selector args)
                       (handle-repl-message ide id selector args)))))
      (setf id channel)
      (handler-case
          (destructuring-bind (server-id thread-id)
              (client-call client
                           (list (sym "slynk-mrepl:create-mrepl") id))
            (with-lock-held ((ide-lock ide))
              (setf (gethash id (ide-repls ide))
                    (make-repl server-id thread-id)))
            (make-object "replId" id))
        (slynk-error (condition)
          (close-channel client id)
          (raise +slynk-failure+ (princ-to-string condition)))))))

(defun send-to-repl (ide params)
  "Handle ide/repl/send: give the REPL a line of input."
  (let ((repl (find-repl ide params))
        (text (required-string params "text"))
        (client (require-client ide)))
    (handler-case (channel-send client (repl-server-id repl) :process text)
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))
    nil))

(defun interrupt-repl (ide params)
  "Handle ide/repl/interrupt: interrupt the thread of the REPL."
  (let ((repl (find-repl ide params))
        (client (require-client ide)))
    (handler-case (client-interrupt client (repl-thread-id repl))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))
    nil))

(defun close-repl (ide params)
  "Handle ide/repl/close: tear the REPL down on both sides."
  (let* ((id (required-integer params "replId"))
         (repl (find-repl ide params))
         (client (require-client ide)))
    (with-lock-held ((ide-lock ide))
      (remhash id (ide-repls ide)))
    (ignore-errors (channel-send client (repl-server-id repl) :teardown))
    (close-channel client id)
    nil))


;;; Registration

(defun register-ide-method (ide name function)
  "Register NAME on the server of IDE; FUNCTION takes IDE and the
params of a request."
  (register-method (ide-server ide) name
                   (lambda (params)
                     (funcall function ide params))))

(defun register-ide-methods (server)
  "Register the ide/ methods on SERVER and return the IDE they share.
Call this before the server starts."
  (let ((ide (make-ide server)))
    (flet ((register (name function)
             (register-method server name
                              (lambda (params)
                                (funcall function ide params)))))
      (register "ide/connect" #'connect)
      (register "ide/disconnect"
                (lambda (ide params)
                  (declare (ignore params))
                  (disconnect ide)
                  nil))
      (register "ide/eval" #'evaluate)
      (register "ide/sylvesters" #'sylvesters)
      (register "ide/repl/create" #'create-repl)
      (register "ide/repl/send" #'send-to-repl)
      (register "ide/repl/interrupt" #'interrupt-repl)
      (register "ide/repl/close" #'close-repl))
    ide))
