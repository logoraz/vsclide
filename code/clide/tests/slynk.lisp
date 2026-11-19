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
  (:import-from :clide/base/debugger
                #:register-debugger-methods)
  (:import-from :clide/base/inspector
                #:register-inspector-methods)
  (:import-from :clide/base/language
                #:register-language-methods
                #:documentation-body)
  (:import-from :clide/base/compiler
                #:register-compiler-methods)
  (:import-from :clide/base/stickers
                #:register-sticker-methods)
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

(defun send-request (session method &optional params)
  "Send METHOD to the clide server without waiting; return the id.
Use AWAIT-REPLY for the reply."
  (let ((id (session-next-id session))
        (request (make-object "jsonrpc" "2.0" "method" method)))
    (incf (session-next-id session))
    (setf (gethash "id" request) id)
    (when params
      (setf (gethash "params" request) params))
    (write-message (session-stream session) request)
    id))

(defun await-reply (session id)
  "Return the reply to request ID, keeping notifications that come first."
  (loop :for message := (read-message (session-stream session))
        :do (cond ((eq message :eof) (error "connection closed"))
                  ((note-p message)
                   (setf (session-notes session)
                         (append (session-notes session) (list message))))
                  ((eql id (gethash "id" message))
                   (return message)))))

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
      (let ((ide (register-ide-methods server)))
        (register-debugger-methods ide)
        (register-inspector-methods ide)
        (register-language-methods ide)
        (register-compiler-methods ide)
        (register-sticker-methods ide))
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

(test repl-value-can-be-inspected
  "A REPL value names its place, and can be inspected from there."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(list 1 2)")
      (let* ((note (await-note session "ide/repl/values"))
             (value (aref (gethash "values" (gethash "params" note)) 0))
             (content (result
                       (rpc session "ide/inspect/replValue"
                            (make-object "replId" id
                                         "entry" (gethash "index" value)
                                         "value" (gethash "value" value))))))
        (is (= 0 (gethash "value" value)))
        (is (search "CONS" (gethash "title" content)))
        (is (plusp (length (gethash "parts" content))))))))

(test repl-output
  "Output printed by the code arrives as a notification."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(format t \"hello~%\")")
      (is (await-note session "ide/repl/output"
                      (lambda (params)
                        (search "hello" (gethash "text" params))))))))

(defun quit-debugger (session open)
  "Quit the debugger described by the ide/debug/open params OPEN."
  (result (rpc session "ide/debug/quit" (debug-params open))))

(test repl-survives-errors
  "An error opens the debugger; quitting aborts the evaluation and the
REPL still works."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(error \"boom\")")
      (let ((open (gethash "params" (await-note session "ide/debug/open"))))
        (is (search "boom" (gethash "message" (gethash "condition" open))))
        (quit-debugger session open))
      (await-note session "ide/repl/aborted")
      (await-prompt session)
      (repl-send session id "(+ 1 1)")
      (is (value-text-p "2" (await-note session "ide/repl/values"))))))

(test repl-interrupt
  "A running evaluation can be interrupted, which opens the debugger."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((id (create-repl session)))
      (repl-send session id "(loop (sleep 0.01))")
      (sleep 0.5)
      (result (rpc session "ide/repl/interrupt"
                   (make-object "replId" id)))
      (quit-debugger session
                     (gethash "params"
                              (await-note session "ide/debug/open")))
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


;;; Debugger tests

(defun start-debugging (session code)
  "Evaluate CODE with the debugger on, wait for the debugger to open
and return the request id of the evaluation and the open params."
  (let* ((id (send-request session "ide/eval"
                           (make-object "code" code "debug" t)))
         (note (await-note session "ide/debug/open")))
    (values id (gethash "params" note))))

(defun debug-params (open &rest pairs)
  "Return request params for the debugger named by the OPEN params,
with PAIRS added."
  (let ((params (make-object "threadId" (gethash "threadId" open))))
    (loop :for (key value) :on pairs :by #'cddr
          :do (setf (gethash key params) value))
    params))

(defun restart-index (open name)
  "Return the index of the first restart called NAME in OPEN, or NIL."
  (position name (gethash "restarts" open)
            :key (lambda (restart) (gethash "name" restart))
            :test #'string=))

(defun finish-debugging (session id open)
  "Quit the debugger of OPEN and return the reply to evaluation ID."
  (result (rpc session "ide/debug/quit" (debug-params open)))
  (await-note session "ide/debug/return")
  (await-reply session id))

(test debug-evaluation-without-error
  "With the debugger on, a good evaluation is still a plain value."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((value (result (rpc session "ide/eval"
                              (make-object "code" "(+ 1 2)" "debug" t)))))
      (is (eq t (gethash "ok" value)))
      (is (eql 0 (search "3" (gethash "value" value)))))))

(test debug-opens-on-error
  "An error opens the debugger with its condition, restarts and frames."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus boom\")")
      (is (integerp (gethash "threadId" open)))
      (is (= 1 (gethash "level" open)))
      (is (search "locutus boom"
                  (gethash "message" (gethash "condition" open))))
      (is (search "SIMPLE-ERROR"
                  (gethash "type" (gethash "condition" open))))
      (is (restart-index open "ABORT"))
      (is (plusp (length (gethash "frames" open))))
      (let ((frame (aref (gethash "frames" open) 0)))
        (is (= 0 (gethash "index" frame)))
        (is (stringp (gethash "text" frame))))
      (let ((reply (finish-debugging session id open)))
        (is (eq nil (gethash "ok" (result reply))))))))

(test debug-quit-returns-the-evaluation
  "Quitting ends the evaluation with ok false."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus quit\")")
      (let ((value (result (finish-debugging session id open))))
        (is (eq nil (gethash "ok" value)))
        (is (stringp (gethash "error" value)))))))

(test debug-restart-by-index
  "Invoking a restart leaves the debugger."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus restart\")")
      (result (rpc session "ide/debug/restart"
                   (debug-params open
                                 "level" (gethash "level" open)
                                 "index" (restart-index open "ABORT"))))
      (let ((note (await-note session "ide/debug/return")))
        (is (= (gethash "level" open)
               (gethash "level" (gethash "params" note)))))
      (is (eq nil (gethash "ok" (result (await-reply session id))))))))

(test debug-continue
  "The continue restart resumes the evaluation."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(progn (cerror \"Go on\" \"locutus\") 42)")
      (is (restart-index open "CONTINUE"))
      (result (rpc session "ide/debug/continue" (debug-params open)))
      (let ((value (result (await-reply session id))))
        (is (eq t (gethash "ok" value)))
        (is (eql 0 (search "42" (gethash "value" value))))))))

(test debug-backtrace
  "More frames can be fetched, in ranges."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus frames\")")
      (let ((frames (gethash "frames"
                             (result (rpc session "ide/debug/backtrace"
                                          (debug-params open
                                                        "start" 0
                                                        "end" 3))))))
        (is (= 3 (length frames)))
        (is (= 2 (gethash "index" (aref frames 2)))))
      (finish-debugging session id open))))

(test debug-frame-details
  "A frame reports locals, catch tags, its package and a location."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus details\")")
      (let ((details (result (rpc session "ide/debug/frame"
                                  (debug-params open "frame" 0)))))
        (is (vectorp (gethash "locals" details)))
        (is (vectorp (gethash "catchTags" details)))
        (is (stringp (gethash "package" details)))
        (let ((location (gethash "location" details)))
          (is (or (eq 'null location) (hash-table-p location)))))
      (finish-debugging session id open))))

(test debug-eval-in-frame
  "Code runs in a frame, with plain and pretty-printed results."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus eval\")")
      (let ((value (result (rpc session "ide/debug/eval"
                                (debug-params open "frame" 0
                                                   "code" "(+ 1 2)")))))
        (is (eq t (gethash "ok" value)))
        (is (eql 0 (search "3" (gethash "text" value)))))
      (let ((value (result (rpc session "ide/debug/eval"
                                (debug-params open "frame" 0
                                                   "code" "(list 1 2)"
                                                   "pprint" t)))))
        (is (eq t (gethash "ok" value)))
        (is (search "(1 2)" (gethash "text" value))))
      (finish-debugging session id open))))

(test debug-step-needs-a-kind
  "Stepping with an unknown kind is an invalid request."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus step\")")
      (is (= -32602 (error-code
                     (rpc session "ide/debug/step"
                          (debug-params open "frame" 0 "kind" "sideways")))))
      (finish-debugging session id open))))

(test debug-break-on-signals
  "Break on signals toggles, and toggling back restores it."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((first (gethash "message"
                          (result (rpc session "ide/debug/breakOnSignals"))))
          (second (gethash "message"
                           (result (rpc session
                                        "ide/debug/breakOnSignals")))))
      (is (search "*break-on-signals*" first))
      (is (string/= first second)))))

(test debug-needs-a-connection
  "Debugger requests before connecting are not-connected errors."
  (with-ide (session slynk-port)
    (is (= -32002 (error-code
                   (rpc session "ide/debug/backtrace"
                        (make-object "threadId" 1 "start" 0)))))))


;;; Inspector tests

(defun inspect-init (session code)
  "Inspect the value of CODE and return the content object."
  (result (rpc session "ide/inspect/init" (make-object "code" code))))

(defun part-of-kind (content kind)
  "Return the first part of CONTENT with KIND, or NIL."
  (find kind (gethash "parts" content)
        :key (lambda (part) (gethash "kind" part))
        :test #'string=))

(test inspect-a-list
  "A list is inspected into a title and parts, some of them values."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((content (inspect-init session "(list 1 2 3)")))
      (is (stringp (gethash "title" content)))
      (is (integerp (gethash "id" content)))
      (is (plusp (length (gethash "parts" content))))
      (is (part-of-kind content "value"))
      (is (member (gethash "more" content) '(t nil))))))

(test inspect-a-part-and-go-back
  "A value part can be inspected, and pop and next move in the history."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let* ((content (inspect-init session "(list (list 7 8) 2)"))
           (part (part-of-kind content "value"))
           (deeper (result (rpc session "ide/inspect/part"
                                (make-object "index"
                                             (gethash "index" part))))))
      (is (hash-table-p deeper))
      (is (string/= (gethash "title" content) (gethash "title" deeper)))
      (let ((back (result (rpc session "ide/inspect/pop"))))
        (is (string= (gethash "title" content) (gethash "title" back))))
      (let ((forward (result (rpc session "ide/inspect/next"))))
        (is (string= (gethash "title" deeper)
                     (gethash "title" forward)))))))

(test inspect-pop-at-the-start
  "There is nothing before the first object."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (inspect-init session "(list 1)")
    (is (eq 'null (result (rpc session "ide/inspect/pop"))))))

(test inspect-eval-and-describe
  "Code can be evaluated against the object, and the object described."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (inspect-init session "(list 1 2 3)")
    (is (eql 0 (search "3" (gethash "text"
                                    (result (rpc session "ide/inspect/eval"
                                                 (make-object
                                                  "code" "(length *)")))))))
    (is (plusp (length (gethash "text"
                                (result (rpc session
                                             "ide/inspect/describe"))))))))

(test inspect-reinspect-and-verbose
  "Refreshing and toggling verbosity return the object again."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((content (inspect-init session "(list 1 2 3)")))
      (is (hash-table-p (result (rpc session "ide/inspect/reinspect"))))
      (is (hash-table-p (result (rpc session "ide/inspect/toggleVerbose"))))
      (result (rpc session "ide/inspect/toggleVerbose"))
      (is (hash-table-p content)))))

(test inspect-range
  "More parts of a long object can be fetched."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (inspect-init session "(make-list 600 :initial-element 0)")
    (let ((more (result (rpc session "ide/inspect/range"
                             (make-object "from" 0 "to" 50)))))
      (is (plusp (length (gethash "parts" more))))
      (is (= 0 (gethash "start" more)))
      (is (member (gethash "more" more) '(t nil))))))

(test inspect-quit
  "Quitting forgets the history."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (inspect-init session "(list 1)")
    (is (eq 'null (result (rpc session "ide/inspect/quit"))))))

(test inspect-in-a-frame
  "From the debugger, values in a frame and the condition are inspected."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (multiple-value-bind (id open)
        (start-debugging session "(error \"locutus inspect\")")
      (let ((content (result (rpc session "ide/inspect/frame"
                                  (debug-params open "frame" 0
                                                     "code" "(list 4 5)")))))
        (is (hash-table-p content))
        (is (part-of-kind content "value")))
      (is (hash-table-p (result (rpc session "ide/inspect/condition"
                                     (debug-params open)))))
      (finish-debugging session id open))))

(test inspect-needs-a-connection
  "Inspector requests before connecting are not-connected errors."
  (with-ide (session slynk-port)
    (is (= -32002 (error-code
                   (rpc session "ide/inspect/init"
                        (make-object "code" "1")))))))


;;; Language tests

(defun complete-ide (session prefix &optional package)
  "Send ide/complete for PREFIX and return the items."
  (let ((params (make-object "prefix" prefix)))
    (when package
      (setf (gethash "package" params) package))
    (gethash "items" (result (rpc session "ide/complete" params)))))

(defun item-labelled (items label)
  "Return the completion item in ITEMS with LABEL, or NIL."
  (find label items :test #'string=
                    :key (lambda (item) (gethash "label" item))))

(test complete-matches-flexibly
  "Letters spread over a name complete it, with the match chunks."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let* ((items (complete-ide session "mvb" "COMMON-LISP-USER"))
           (item (item-labelled items "multiple-value-bind")))
      (is (not (null item)))
      (is (string= "macro" (gethash "kind" item)))
      (is (numberp (gethash "score" item)))
      (let ((chunk (aref (gethash "chunks" item) 0)))
        (is (= 0 (gethash "start" chunk)))
        (is (stringp (gethash "text" chunk)))))))

(test complete-follows-the-package
  "A symbol of another package completes when that package is current."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (eval-ide session "(defpackage :locutus-package (:use :cl))")
    (eval-ide session "(defun locutus-package::locutus-thing () 1)"
              "LOCUTUS-PACKAGE")
    (is (item-labelled (complete-ide session "locutus-th" "LOCUTUS-PACKAGE")
                       "locutus-thing"))
    (is (null (item-labelled (complete-ide session "locutus-th"
                                           "COMMON-LISP-USER")
                             "locutus-thing")))))

(test complete-nothing-for-an-empty-prefix
  "No prefix, no items."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (is (= 0 (length (complete-ide session ""))))))

(test arglist-of-a-function
  "A function has an arglist; an unknown name has none."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (eval-ide session "(defun locutus-args (a &optional b) (list a b))")
    (let ((result (result (rpc session "ide/arglist"
                               (make-object "name" "locutus-args")))))
      (is (search "&OPTIONAL" (string-upcase (gethash "arglist" result)))))
    (is (eq 'null (gethash "arglist"
                           (result (rpc session "ide/arglist"
                                        (make-object "name"
                                                     "locutus-unknown"))))))))

(test documentation-of-a-function
  "The docstring comes back without slynk's heading."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (eval-ide session
              "(defun locutus-docs (a) \"Locutus docstring.\" a)")
    (let ((text (gethash "text"
                         (result (rpc session "ide/documentation"
                                      (make-object "name" "locutus-docs"))))))
      (is (search "Locutus docstring." text))
      (is (null (search "Documentation for the symbol" text))))
    (is (eq 'null (gethash "text"
                           (result (rpc session "ide/documentation"
                                        (make-object "name"
                                                     "locutus-unknown"))))))))

(test documentation-body-cases
  "Headings are cut; missing documentation is NIL."
  (is (string= "Function:" (documentation-body
                            (format nil "Documentation for the symbol X:~2%~
                                         Function:"))))
  (is (null (documentation-body
             (format nil "Documentation for the symbol X:~2%Not documented."))))
  (is (null (documentation-body "No such symbol, X.")))
  (is (null (documentation-body nil))))

(test definitions-are-found
  "A name of a loaded system has a definition with a file."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let* ((result (result (rpc session "ide/definitions"
                                (make-object "name" "slynk:create-server"))))
           (definitions (gethash "definitions" result)))
      (is (plusp (length definitions)))
      (let ((location (gethash "location" (aref definitions 0))))
        (is (stringp (gethash "file" location)))
        (is (integerp (gethash "position" location)))))))

(test definitions-of-an-unknown-name
  "A name that is nowhere has no definitions."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (is (= 0 (length (gethash "definitions"
                              (result (rpc session "ide/definitions"
                                           (make-object
                                            "name" "locutus-nowhere")))))))))

(test language-needs-a-connection
  "Language requests before connecting are not-connected errors."
  (with-ide (session slynk-port)
    (dolist (method '("ide/complete" "ide/arglist" "ide/documentation"
                      "ide/definitions"))
      (is (= -32002 (error-code
                     (rpc session method
                          (make-object "prefix" "a" "name" "a"))))))))


;;; Compiler tests

(defun compile-ide (session code &key (position 0) file package)
  "Send ide/compile and return the result object."
  (let ((params (make-object "code" code "position" position)))
    (when file
      (setf (gethash "file" params) file))
    (when package
      (setf (gethash "package" params) package))
    (result (rpc session "ide/compile" params))))

(test compile-good-code
  "Code that compiles cleanly is ok with no notes, and is loaded."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((result (compile-ide session "(defun locutus-good (x) x)"
                               :file "/tmp/locutus-good.lisp")))
      (is (eq t (gethash "ok" result)))
      (is (= 0 (length (gethash "notes" result)))))
    (is (eql 0 (search "7" (gethash "value"
                                    (eval-ide session "(locutus-good 7)")))))))

(test compile-reports-warnings-where-they-are
  "A warning has its severity, message and a position inside the code."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let* ((code "(defun locutus-warn () locutus-undefined-variable)")
           (result (compile-ide session code :position 100
                                             :file "/tmp/locutus-warn.lisp"))
           (note (find "warning" (gethash "notes" result)
                       :key (lambda (note) (gethash "severity" note))
                       :test #'string=)))
      (is (not (null note)))
      (is (search "LOCUTUS-UNDEFINED-VARIABLE"
                  (string-upcase (gethash "message" note))))
      (let ((position (gethash "position" (gethash "location" note))))
        (is (integerp position))
        (is (<= 101 position (+ 101 (length code))))))))

(test compile-gives-frames-a-source
  "A function compiled from a file position has that file, as its buffer,
and a position in its debugger frame."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (compile-ide session "(defun locutus-fail () (error \"locutus\"))"
                 :position 40 :file "/tmp/locutus-fail.lisp")
    (multiple-value-bind (id open) (start-debugging session "(locutus-fail)")
      (let ((location
              (loop :for frame :from 0 :below 6
                    :for details := (result
                                     (rpc session "ide/debug/frame"
                                          (debug-params open "frame" frame)))
                    :for location := (gethash "location" details)
                    :when (and (hash-table-p location)
                               (equal "/tmp/locutus-fail.lisp"
                                      (gethash "buffer" location)))
                      :return location)))
        (is (not (null location)))
        (when location
          (is (integerp (gethash "position" location)))
          (is (<= 41 (gethash "position" location) 100))))
      (finish-debugging session id open))))

(test compile-in-a-package
  "Code is read in the package given."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (eval-ide session "(defpackage :locutus-compile (:use :cl))")
    (let ((result (compile-ide session "(defun locutus-in-package () 1)"
                               :package "LOCUTUS-COMPILE")))
      (is (eq t (gethash "ok" result))))
    (is (eql 0 (search "1" (gethash "value"
                                    (eval-ide
                                     session "(locutus-in-package)"
                                     "LOCUTUS-COMPILE")))))))

(test compile-a-file
  "A file is compiled, and its fasl is named."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((file (format nil "/tmp/locutus-file-~d.lisp" (random 1000000))))
      (with-open-file (out file :direction :output :if-exists :supersede)
        (write-line "(defun locutus-file () 1)" out))
      (unwind-protect
           (let ((result (result (rpc session "ide/compileFile"
                                      (make-object "file" file "load" t)))))
             (is (eq t (gethash "ok" result)))
             (is (stringp (gethash "fasl" result))))
        (ignore-errors (delete-file file))
        (ignore-errors (delete-file (compile-file-pathname file)))))))

(test compiler-needs-a-connection
  "Compiling before connecting is a not-connected error."
  (with-ide (session slynk-port)
    (is (= -32002 (error-code
                   (rpc session "ide/compile"
                        (make-object "code" "1" "position" 0)))))
    (is (= -32002 (error-code
                   (rpc session "ide/compileFile"
                        (make-object "file" "/tmp/x.lisp")))))))


;;; Sticker tests

(defun stickers-ide (session method &rest pairs)
  "Send the ide/stickers/ METHOD with the object of PAIRS and return the
result object."
  (result (rpc session (concatenate 'string "ide/stickers/" method)
               (apply #'make-object pairs))))

(defun compile-stickered (session code &key original (stickers #(1)))
  "Send ide/stickers/compile for CODE and return the result object."
  (let ((params (make-object "code" code "position" 0 "stickers" stickers
                             "file" "/tmp/locutus-sticker.lisp")))
    (when original
      (setf (gethash "original" params) original))
    (result (rpc session "ide/stickers/compile" params))))

(test stickers-record-what-a-form-returns
  "A stickered form is recorded each time it runs."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((reply (compile-stickered
                  session
                  "(defun locutus-st (x) (slynk-stickers:record 8101 (* x 2)))"
                  :stickers #(8101))))
      (is (eq t (gethash "stuck" reply)))
      (is (eq t (gethash "ok" (gethash "result" reply)))))
    (eval-ide session "(locutus-st 4)")
    (eval-ide session "(locutus-st 5)")
    (let* ((stickers (gethash "stickers" (stickers-ide session "fetch")))
           (sticker (find 8101 stickers
                          :key (lambda (s) (gethash "id" s)))))
      (is (not (null sticker)))
      (is (= 2 (gethash "count" sticker)))
      (let ((recording (gethash "recording" sticker)))
        (is (eql 0 (search "10" (aref (gethash "values" recording) 0))))
        (is (not (gethash "exited" recording)))))))

(test stickers-fall-back-to-the-original
  "When the wrapped code does not compile the original is, and the
stickers are not stuck."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((reply (compile-stickered
                  session "(defun locutus-fb () (no-such-package-xyz:f))"
                  :original "(defun locutus-fb () 7)"
                  :stickers #(8102))))
      (is (not (gethash "stuck" reply)))
      (is (eq t (gethash "ok" (gethash "result" reply)))))
    (is (search "7" (gethash "value" (eval-ide session "(locutus-fb)"))))
    (is (null (find 8102 (gethash "stickers" (stickers-ide session "fetch"))
                    :key (lambda (s) (gethash "id" s)))))))

(test stickers-record-exits
  "A form left by an error is recorded as exited."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (compile-stickered
     session
     "(defun locutus-ex () (slynk-stickers:record 8103 (error \"locutus\")))"
     :stickers #(8103))
    (multiple-value-bind (id open) (start-debugging session "(locutus-ex)")
      (finish-debugging session id open))
    (let* ((reply (stickers-ide session "search" "index" 1 "key" 1
                                 "sticker" 8103))
           (sticker (gethash "sticker" reply)))
      (is (integerp (gethash "total" reply)))
      (is (= 8103 (gethash "id" sticker)))
      (is (eq t (gethash "exited" (gethash "recording" sticker)))))))

(test stickers-search-and-forget
  "The playhead moves over recordings, and forgetting empties them."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (compile-stickered
     session "(defun locutus-sr (x) (slynk-stickers:record 8104 x))"
     :stickers #(8104))
    (eval-ide session "(locutus-sr 1)")
    (eval-ide session "(locutus-sr 2)")
    (let ((reply (stickers-ide session "search" "index" 1 "key" 2
                               "sticker" 8104)))
      (is (<= 2 (gethash "total" reply)))
      (is (= 8104 (gethash "id" (gethash "sticker" reply)))))
    (is (= 0 (gethash "remaining" (stickers-ide session "forget"))))
    (is (gethash "error" (stickers-ide session "search" "index" 1 "key" 3)))))

(test stickers-toggle-breaking
  "Breaking on stickers is switched on, then off."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (let ((first (gethash "on" (stickers-ide session "toggleBreak")))
          (second (gethash "on" (stickers-ide session "toggleBreak"))))
      (is (not (eq first second))))))

(test stickers-breakpoint-enters-the-debugger
  "A breakpoint stops before its form, and the debugger says which."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (compile-stickered
     session
     (concatenate 'string
                  "(defun locutus-bp (x) (slynk-stickers:record 8105 "
                  "(progn (clide-image::break-here 8105) (+ x 1))))")
     :stickers #(8105))
    (multiple-value-bind (id open) (start-debugging session "(locutus-bp 1)")
      (let ((sticker (gethash "sticker" (gethash "condition" open))))
        (is (hash-table-p sticker))
        (is (equal "breakpoint" (gethash "kind" sticker)))
        (is (= 8105 (gethash "id" sticker))))
      (finish-debugging session id open))))

(test stickers-inspect
  "A sticker can be inspected."
  (with-ide (session slynk-port)
    (connect-ide session slynk-port)
    (compile-stickered
     session "(defun locutus-si () (slynk-stickers:record 8106 1))"
     :stickers #(8106))
    (eval-ide session "(locutus-si)")
    (let ((content (stickers-ide session "inspect" "sticker" 8106)))
      (is (stringp (gethash "title" content))))))

(test stickers-need-a-connection
  "Sticker requests before connecting are not-connected errors."
  (with-ide (session slynk-port)
    (dolist (method '("compile" "kill" "fetch" "search" "forget"
                      "toggleBreak" "inspect"))
      (is (= -32002 (error-code
                     (rpc session (concatenate 'string "ide/stickers/" method)
                          (make-object "code" "1" "position" 0
                                       "index" 1 "sticker" 1))))))))
