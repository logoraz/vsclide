(defpackage :clide/tests/slynk
  (:use :cl :5am)
  (:import-from :clide/tests/suite
                #:suite)
  (:import-from :bordeaux-threads
                #:make-thread)
  (:import-from :usocket
                #:socket-connect
                #:socket-close
                #:socket-shutdown
                #:socket-stream)
  (:import-from :clide/lib/jsonrpc
                #:read-message
                #:write-message
                #:make-object)
  (:import-from :clide/lib/slynk-wire
                #:sym)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:connect-client
                #:close-client
                #:client-call)
  (:import-from :clide/base/server
                #:make-server
                #:start-server
                #:stop-server)
  (:import-from :clide/base/ide
                #:register-ide-methods)
  (:export #:slynk-suite)
  (:documentation "Tests of the slynk client and the ide methods, run
against a real slynk server in this image."))

(in-package :clide/tests/slynk)


;;; Code:

(def-suite slynk-suite
  :description "Tests against a real slynk server."
  :in suite)

(in-suite slynk-suite)


;;; Fixtures

(defmacro with-deadline ((socket seconds) &body body)
  "Run BODY, shutting SOCKET down after SECONDS so that a read blocked
on it fails instead of hanging the test run."
  (let ((finished (gensym "FINISHED")))
    `(let ((,finished nil))
       (make-thread (lambda ()
                      (sleep ,seconds)
                      (unless ,finished
                        (ignore-errors (socket-shutdown ,socket :io))))
                    :name "test-watchdog")
       (unwind-protect (progn ,@body)
         (setf ,finished t)))))

(defvar *slynk-port* nil
  "The port of the slynk server shared by all tests, once started.")

(defun slynk-port ()
  "Return the port of the shared slynk server, starting it on first use.
One server serves every test and is never stopped: slynk's sentinel
thread races with a server that is created just after another one is
stopped, which makes a test server refuse connections now and then."
  (or *slynk-port*
      (setf *slynk-port* (slynk:create-server :port 0 :dont-close t))))

(defmacro with-slynk ((port) &body body)
  "Run BODY with PORT bound to the port of the shared slynk server."
  `(let ((,port (slynk-port)))
     ,@body))

(defmacro with-client ((client port) &body body)
  "Run BODY with CLIENT connected to the slynk server on PORT."
  `(let ((,client (connect-client "127.0.0.1" ,port)))
     (unwind-protect (progn ,@body)
       (close-client ,client))))

(defun slynk-call (client form)
  "Evaluate the wire FORM in slynk through CLIENT, waiting 20 seconds."
  (client-call client form :timeout 20))


;;; Client tests

(test client-connection-info
  "The server reports the implementation this image runs."
  (with-slynk (port)
    (with-client (client port)
      (let* ((info (slynk-call client (list (sym "slynk:connection-info"))))
             (implementation (getf info :lisp-implementation)))
        (is (string= (lisp-implementation-type)
                     (getf implementation :type)))
        (is (string= (lisp-implementation-version)
                     (getf implementation :version)))))))

(test client-eval
  "Slynk evaluates a string and returns its output and value."
  (with-slynk (port)
    (with-client (client port)
      (destructuring-bind (output value)
          (slynk-call client
                      (list (sym "slynk:eval-and-grab-output") "(+ 1 2)"))
        (is (string= "" output))
        (is (eql 0 (search "3" value)))))))

(test client-abort-is-an-error
  "A server abort becomes a SLYNK-ERROR."
  (with-slynk (port)
    (with-client (client port)
      (signals slynk-error
        (slynk-call client (list (sym "cl:abort")))))))

(test client-closed-refuses-calls
  "After CLOSE-CLIENT, calls signal SLYNK-ERROR."
  (with-slynk (port)
    (let ((client (connect-client "127.0.0.1" port)))
      (close-client client)
      (signals slynk-error
        (slynk-call client (list (sym "slynk:connection-info")))))))

(test client-reports-closing
  "The event function is told when the connection ends."
  (with-slynk (port)
    (let* ((events '())
           (client (connect-client "127.0.0.1" port
                                   :event-fn (lambda (client event)
                                               (declare (ignore client))
                                               (push event events)))))
      (slynk-call client (list (sym "slynk:connection-info")))
      (close-client client)
      (is (member '(:closed "closed by clide") events :test #'equal)))))


;;; IDE method tests
;;;
;;; These talk JSON-RPC to a clide server with the ide methods, as jekyl
;;; does, and the server talks slynk to the server started here.

(defstruct (session (:constructor make-session (socket stream)))
  "A test client of the clide server.  NOTES holds notifications that
arrived while waiting for something else."
  socket
  stream
  (next-id 1)
  (notes '()))

(defun note-p (message)
  "Return true when MESSAGE is a notification, not a reply."
  (and (gethash "method" message)
       (null (gethash "id" message))))

(defun rpc (session method &optional params)
  "Call METHOD on the clide server and return the reply object.
Notifications that arrive first are kept in SESSION."
  (let ((id (session-next-id session))
        (request (make-object "jsonrpc" "2.0" "method" method)))
    (incf (session-next-id session))
    (setf (gethash "id" request) id)
    (when params
      (setf (gethash "params" request) params))
    (write-message (session-stream session) request)
    (loop :for message := (read-message (session-stream session))
          :do (cond ((eq message :eof) (error "connection closed"))
                    ((note-p message)
                     (setf (session-notes session)
                           (append (session-notes session) (list message))))
                    ((eql id (gethash "id" message))
                     (return message))))))

(defun result (reply)
  "Return the result of REPLY, checking that it is not an error."
  (is (null (gethash "error" reply)) "Unexpected error reply: ~a"
      (let ((error-object (gethash "error" reply)))
        (and error-object (gethash "message" error-object))))
  (gethash "result" reply))

(defun error-code (reply)
  "Return the error code of REPLY, or NIL when it is not an error."
  (let ((error-object (gethash "error" reply)))
    (and error-object (gethash "code" error-object))))

(defun await-note (session method &optional (test (constantly t)))
  "Return the first notification of METHOD whose params pass TEST,
reading more messages when none is kept.  It is removed from SESSION."
  (flet ((matches (message)
           (and (equal method (gethash "method" message))
                (funcall test (gethash "params" message)))))
    (loop
      (let ((found (find-if #'matches (session-notes session))))
        (when found
          (setf (session-notes session)
                (remove found (session-notes session)))
          (return found)))
      (let ((message (read-message (session-stream session))))
        (when (eq message :eof)
          (error "connection closed while waiting for ~a" method))
        (when (note-p message)
          (setf (session-notes session)
                (append (session-notes session) (list message))))))))

(defun forget-notes (session method)
  "Drop the kept notifications of METHOD."
  (setf (session-notes session)
        (remove method (session-notes session)
                :key (lambda (message) (gethash "method" message))
                :test #'equal)))

(defun call-with-ide (function)
  "Call FUNCTION with a session on a clide server and the port of a
slynk server, both running here, then stop everything."
  (with-slynk (slynk-port)
    (let ((server (make-server :token "locutus-token")))
      (register-ide-methods server)
      (let* ((socket (socket-connect "127.0.0.1" (start-server server)
                                     :element-type '(unsigned-byte 8)))
             (session (make-session socket (socket-stream socket))))
        (unwind-protect
             (with-deadline (socket 90)
               (rpc session "initialize"
                    (make-object "token" "locutus-token"))
               (funcall function session slynk-port))
          (ignore-errors (socket-close socket))
          (stop-server server))))))

(defmacro with-ide ((session slynk-port) &body body)
  "Run BODY with SESSION on a clide server and SLYNK-PORT the port of a
slynk server it can connect to."
  `(call-with-ide (lambda (,session ,slynk-port)
                    (declare (ignorable ,slynk-port))
                    ,@body)))

(defun connect-ide (session slynk-port)
  "Send ide/connect for SLYNK-PORT and return the result."
  (result (rpc session "ide/connect" (make-object "port" slynk-port))))

(defun eval-ide (session code &optional package)
  "Send ide/eval for CODE and return the result object."
  (let ((params (make-object "code" code)))
    (when package
      (setf (gethash "package" params) package))
    (result (rpc session "ide/eval" params))))

(test ide-needs-a-connection
  "Evaluating before connecting is a not-connected error."
  (with-ide (session slynk-port)
    (is (= -32002 (error-code (rpc session "ide/eval"
                                   (make-object "code" "1")))))))

(test ide-connect-refused
  "Connecting to a port with no server is a slynk failure."
  (with-ide (session slynk-port)
    (is (= -32003 (error-code (rpc session "ide/connect"
                                   (make-object "port" 1)))))))

(test ide-connect-reports-implementation
  "ide/connect returns the implementation type and version."
  (with-ide (session slynk-port)
    (let* ((info (connect-ide session slynk-port))
           (implementation (gethash "implementation" info)))
      (is (string= (lisp-implementation-type)
                   (gethash "type" implementation)))
      (is (string= (lisp-implementation-version)
                   (gethash "version" implementation)))
      (is (integerp (gethash "pid" info)))
      (is (stringp (gethash "name" (gethash "package" info)))))))

(test ide-eval-value
  "ide/eval returns the printed value and no output."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((reply (eval-ide session "(+ 1 2)")))
      (is (eq t (gethash "ok" reply)))
      (is (string= "3" (gethash "value" reply)))
      (is (string= "" (gethash "output" reply))))))

(test ide-eval-output
  "ide/eval returns what the code printed, apart from its value."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((reply (eval-ide session "(progn (princ \"hi\") 42)")))
      (is (string= "hi" (gethash "output" reply)))
      (is (string= "42" (gethash "value" reply))))))

(test ide-eval-error
  "A Lisp error is a normal reply with ok false and the message."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((reply (eval-ide session "(error \"boom ~a\" 7)")))
      (is (eq nil (gethash "ok" reply)))
      (is (search "boom 7" (gethash "error" reply))))
    (is (string= "2" (gethash "value" (eval-ide session "(+ 1 1)"))))))

(test ide-eval-package
  "The package parameter sets *package* for the evaluation."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (is (search "COMMON-LISP"
                (gethash "value"
                         (eval-ide session "(package-name *package*)"
                                   "COMMON-LISP"))))))

(test ide-eval-unicode
  "Non-ASCII text survives the trip through both protocols."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let* ((text (format nil "caf~c ~c" (code-char #xe9) (code-char #x3bb)))
           (reply (eval-ide session (format nil "(princ ~s)" text))))
      (is (string= text (gethash "output" reply))))))

(test ide-sylvesters
  "ide/sylvesters returns the text of slynk's own sylvesters.txt, or
null when this install has none; it needs a connection."
  (with-ide (session slynk-port)
    (is (= -32002 (error-code (rpc session "ide/sylvesters"))))
    (connect-ide session slynk-port)
    (let ((text (gethash "text" (result (rpc session "ide/sylvesters")))))
      (is (or (eq 'null text)
              (and (stringp text) (search "@@@@" text)))))))

(test ide-disconnect
  "After ide/disconnect, evaluating is a not-connected error."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (is (eq 'null (result (rpc session "ide/disconnect"))))
    (is (= -32002 (error-code (rpc session "ide/eval"
                                   (make-object "code" "1")))))))


;;; REPL tests

(defun create-repl (session)
  "Create a REPL, wait for its first prompt and return its id."
  (let ((id (gethash "replId" (result (rpc session "ide/repl/create")))))
    (await-note session "ide/repl/prompt")
    id))

(defun repl-send (session id text)
  "Send TEXT to REPL ID, after dropping prompts seen so far."
  (forget-notes session "ide/repl/prompt")
  (result (rpc session "ide/repl/send"
               (make-object "replId" id "text" text))))

(defun await-prompt (session)
  "Wait for the next prompt notification."
  (await-note session "ide/repl/prompt"))

(defun value-text-p (text note)
  "Return true when the first value in the ide/repl/values NOTE starts
with TEXT.  Slynk adds bit counts and radixes after integers."
  (eql 0 (search text (first-value-text note))))

(defun first-value-text (note)
  "Return the text of the first value in the ide/repl/values NOTE."
  (gethash "text" (aref (gethash "values"
                                 (gethash "params" note))
                        0)))

(test repl-evaluates
  "A REPL returns values and then prompts again."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(+ 40 2)")
      (let ((note (await-note session "ide/repl/values")))
        (is (= id (gethash "replId" (gethash "params" note))))
        (is (value-text-p "42" note)))
      (await-prompt session)
      (repl-send session id "(* 6 7)")
      (is (value-text-p "42" (await-note session "ide/repl/values"))))))

(test repl-keeps-history
  "The prompt counts the entries evaluated so far."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "1")
      (let ((note (await-prompt session)))
        (is (= 1 (gethash "entry" (gethash "params" note))))
        (is (= 0 (gethash "level" (gethash "params" note))))))))

(test repl-output
  "Output printed by the code arrives as a notification."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(format t \"hello~%\")")
      (is (await-note session "ide/repl/output"
                      (lambda (params)
                        (search "hello" (gethash "text" params))))))))

(test repl-survives-errors
  "An error aborts the evaluation, and the REPL still works."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(error \"boom\")")
      (let ((note (await-note session "ide/repl/aborted")))
        (is (search "boom" (gethash "message" (gethash "params" note)))))
      (await-prompt session)
      (repl-send session id "(+ 1 1)")
      (is (value-text-p "2" (await-note session "ide/repl/values"))))))

(test repl-interrupt
  "A running evaluation can be interrupted."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(loop (sleep 0.01))")
      (sleep 0.5)
      (result (rpc session "ide/repl/interrupt"
                   (make-object "replId" id)))
      (await-note session "ide/repl/aborted")
      (await-prompt session)
      (repl-send session id "(+ 1 1)")
      (is (value-text-p "2" (await-note session "ide/repl/values"))))))

(test repl-close
  "A closed REPL is gone."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (is (eq 'null (result (rpc session "ide/repl/close"
                                 (make-object "replId" id)))))
      (is (= -32602 (error-code
                     (rpc session "ide/repl/send"
                          (make-object "replId" id "text" "1"))))))))

(test repl-two-at-once
  "Two REPLs keep separate histories."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((one (create-repl session))
          (two (create-repl session)))
      (is (/= one two))
      (repl-send session one "(defvar *clide-test* 5)")
      (await-note session "ide/repl/values")
      (await-prompt session)
      (repl-send session two "(+ 1 1)")
      (let ((note (await-note session "ide/repl/values")))
        (is (= two (gethash "replId" (gethash "params" note))))))))
