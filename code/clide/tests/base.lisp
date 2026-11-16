(defpackage :clide/tests/base
  (:use :cl :5am)
  (:import-from :clide/tests/suite
                #:suite)
  (:import-from :usocket
                #:socket-connect
                #:socket-close
                #:socket-stream)
  (:import-from :clide/lib/jsonrpc
                #:read-message
                #:write-message
                #:make-object
                #:jsonrpc-error)
  (:import-from :clide/base/server
                #:make-server
                #:server-port
                #:register-method
                #:broadcast
                #:start-server
                #:stop-server)
  (:export #:base-suite)
  (:documentation "Tests for the base module."))

(in-package :clide/tests/base)


;;; Code:

(def-suite base-suite
  :description "Tests for base module."
  :in suite)

(in-suite base-suite)

(defun token ()
  "Return the session token used by the test server."
  "locutus-token")

(defun make-test-server ()
  "Return a started server with ping and a slow method registered, and
its port as the second value."
  (let ((server (make-server :token (token))))
    (register-method server "ping" (lambda (params)
                                     (declare (ignore params))
                                     "pong"))
    (register-method server "slow" (lambda (params)
                                     (declare (ignore params))
                                     (sleep 1)
                                     "slow-done"))
    (register-method server "emit"
                     (lambda (params)
                       (declare (ignore params))
                       (broadcast server "event" (make-object "n" 1))
                       "emitted"))
    (values server (start-server server))))

(defmacro with-test-server ((port) &body body)
  "Run BODY with PORT bound to a running test server, then stop it."
  (let ((server (gensym "SERVER")))
    `(multiple-value-bind (,server ,port) (make-test-server)
       (unwind-protect (progn ,@body)
         (stop-server ,server)))))

(defun connect (port)
  "Open a binary client connection to PORT.  Return the socket and its
stream."
  (let ((socket (socket-connect "127.0.0.1" port
                                :element-type '(unsigned-byte 8))))
    (values socket (socket-stream socket))))

(defun request (id method &optional params)
  "Return a request object for ID, METHOD and optional PARAMS."
  (let ((message (make-object "jsonrpc" "2.0" "id" id "method" method)))
    (when params
      (setf (gethash "params" message) params))
    message))

(defun call (stream id method &optional params)
  "Send a request on STREAM and return the reply."
  (write-message stream (request id method params))
  (read-message stream))

(defun initialize (stream token)
  "Send initialize with TOKEN on STREAM and return the reply."
  (call stream 1 "initialize" (make-object "token" token)))

(defun error-code (reply)
  "Return the error code in REPLY, or NIL when it is not an error."
  (let ((error-object (gethash "error" reply)))
    (and error-object (gethash "code" error-object))))

(test ping-round-trip
  "initialize with the token, then ping returns pong."
  (with-test-server (port)
    (multiple-value-bind (socket stream) (connect port)
      (unwind-protect
           (progn
             (is (null (error-code (initialize stream (token)))))
             (is (string= "pong" (gethash "result"
                                          (call stream 2 "ping")))))
        (socket-close socket)))))

(test wrong-token-rejected
  "A wrong token gets +UNAUTHORIZED+ and the connection closes."
  (with-test-server (port)
    (multiple-value-bind (socket stream) (connect port)
      (unwind-protect
           (progn
             (is (= -32001 (error-code (initialize stream "wrong"))))
             (is (eq :eof (read-message stream))))
        (socket-close socket)))))

(test first-message-must-initialize
  "Any other first method is rejected."
  (with-test-server (port)
    (multiple-value-bind (socket stream) (connect port)
      (unwind-protect
           (progn
             (is (= -32001 (error-code (call stream 1 "ping"))))
             (is (eq :eof (read-message stream))))
        (socket-close socket)))))

(test unknown-method
  "An unknown method returns +METHOD-NOT-FOUND+."
  (with-test-server (port)
    (multiple-value-bind (socket stream) (connect port)
      (unwind-protect
           (progn
             (initialize stream (token))
             (is (= -32601 (error-code (call stream 2 "nope")))))
        (socket-close socket)))))

(test concurrent-clients
  "Two clients are served at the same time."
  (with-test-server (port)
    (multiple-value-bind (socket-a stream-a) (connect port)
      (multiple-value-bind (socket-b stream-b) (connect port)
        (unwind-protect
             (progn
               (initialize stream-a (token))
               (initialize stream-b (token))
               (write-message stream-a (request 2 "slow"))
               (let* ((start (get-internal-real-time))
                      (reply (call stream-b 2 "ping"))
                      (elapsed (/ (- (get-internal-real-time) start)
                                  internal-time-units-per-second)))
                 (is (string= "pong" (gethash "result" reply)))
                 (is (< elapsed 0.5)))
               (is (string= "slow-done"
                            (gethash "result" (read-message stream-a)))))
          (socket-close socket-a)
          (socket-close socket-b))))))

(test requests-overlap-on-one-connection
  "A fast request is answered while a slow one on the same connection
is still running."
  (with-test-server (port)
    (multiple-value-bind (socket stream) (connect port)
      (unwind-protect
           (progn
             (initialize stream (token))
             (write-message stream (request 2 "slow"))
             (write-message stream (request 3 "ping"))
             (let ((first (read-message stream))
                   (second (read-message stream)))
               (is (= 3 (gethash "id" first)))
               (is (string= "pong" (gethash "result" first)))
               (is (= 2 (gethash "id" second)))
               (is (string= "slow-done" (gethash "result" second)))))
        (socket-close socket)))))

(test broadcast-reaches-ready-clients
  "A notification comes before the reply of the method that sent it,
and has no id."
  (with-test-server (port)
    (multiple-value-bind (socket stream) (connect port)
      (unwind-protect
           (progn
             (initialize stream (token))
             (write-message stream (request 2 "emit"))
             (let ((notification (read-message stream))
                   (reply (read-message stream)))
               (is (string= "event" (gethash "method" notification)))
               (is (null (gethash "id" notification)))
               (is (= 1 (gethash "n" (gethash "params" notification))))
               (is (string= "emitted" (gethash "result" reply)))))
        (socket-close socket)))))
