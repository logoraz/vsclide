(defpackage :clide/base/server
  (:use :cl)
  (:import-from :bordeaux-threads
                #:make-lock
                #:make-thread
                #:join-thread
                #:current-thread
                #:with-lock-held)
  (:import-from :usocket
                #:socket-listen
                #:socket-connect
                #:socket-accept
                #:socket-close
                #:socket-stream
                #:get-local-port)
  (:import-from :clide/lib/jsonrpc
                #:read-message
                #:write-message
                #:make-object
                #:make-response
                #:make-error-response
                #:message-id
                #:message-method
                #:message-params
                #:jsonrpc-error
                #:jsonrpc-error-code
                #:jsonrpc-error-message
                #:jsonrpc-error-data
                #:+invalid-request+
                #:+method-not-found+
                #:+internal-error+
                #:+unauthorized+)
  (:export #:make-server
           #:server-port
           #:register-method
           #:start-server
           #:stop-server)
  (:documentation "Loopback JSON-RPC server."))

(in-package :clide/base/server)


;;; Code:

(defun ignore-log (control &rest args)
  "Discard a log message.  The default LOG-FN of a server."
  (declare (ignore control args))
  nil)

(defstruct (server (:constructor %make-server))
  "A JSON-RPC server on a loopback socket."
  (methods (make-hash-table :test #'equal) :type hash-table)
  (token "" :type string)
  (log-fn #'ignore-log :type function)
  (lock (make-lock "clide-server"))
  (listener nil)
  (host nil)
  (port nil)
  (accept-thread nil)
  (connections '() :type list))

(defun make-server (&key token log-fn)
  "Return a new server that requires TOKEN in the initialize call.
LOG-FN, if given, is called with a format control and arguments."
  (unless (and (stringp token) (plusp (length token)))
    (error "A non-empty TOKEN string is required."))
  (%make-server :token token
                :log-fn (or log-fn #'ignore-log)))

(defun server-log (server control &rest args)
  "Send a message to the log function of SERVER."
  (apply (server-log-fn server) control args))

(defun register-method (server name handler)
  "Register HANDLER, a function of the params, under method NAME.
Call this before START-SERVER; the table is not locked afterwards."
  (setf (gethash name (server-methods server)) handler))

(defun constant-time-string= (a b)
  "Return true when strings A and B are equal.
The time taken depends only on the lengths of A and B."
  (let ((diff (logxor (length a) (length b))))
    (loop :for i :from 0 :below (max (length a) (length b))
          :do (setf diff
                    (logior diff
                            (logxor (if (< i (length a))
                                        (char-code (char a i))
                                        0)
                                    (if (< i (length b))
                                        (char-code (char b i))
                                        0)))))
    (zerop diff)))

(defun token-valid-p (server candidate)
  "Return true when CANDIDATE equals the session token of SERVER.
The comparison takes constant time."
  (and (stringp candidate)
       (constant-time-string= (server-token server) candidate)))


;;; Dispatch

(defun response-id (request)
  "Return the id to use in a reply to REQUEST, JSON null if absent."
  (or (message-id request) 'null))

(defun run-handler (server request handler)
  "Call HANDLER with the params of REQUEST and return a response.
A JSONRPC-ERROR from the handler becomes an error response with its
code; any other error becomes +INTERNAL-ERROR+."
  (let ((id (message-id request)))
    (handler-case
        (make-response id (funcall handler (message-params request)))
      (jsonrpc-error (condition)
        (make-error-response id
                             (jsonrpc-error-code condition)
                             (jsonrpc-error-message condition)
                             (jsonrpc-error-data condition)))
      (error (condition)
        (server-log server "Handler for ~a failed: ~a"
                    (message-method request) condition)
        (make-error-response id +internal-error+
                             (princ-to-string condition))))))

(defun dispatch (server request)
  "Run the handler for REQUEST.  Return a response object, or NIL for
a notification.  Unknown methods yield +METHOD-NOT-FOUND+."
  (let ((method (message-method request))
        (id (and (hash-table-p request) (message-id request))))
    (cond ((null method)
           (make-error-response (response-id request) +invalid-request+
                                "Not a valid request object."))
          (t
           (let* ((handler (gethash method (server-methods server)))
                  (response
                    (if handler
                        (run-handler server request handler)
                        (make-error-response id +method-not-found+
                                             (format nil "Unknown method: ~a"
                                                     method)))))
             (and id response))))))


;;; Connections

(defun initialize-token (request)
  "Return the token carried by an initialize REQUEST, or NIL."
  (let ((params (message-params request)))
    (and (hash-table-p params)
         (values (gethash "token" params)))))

(defun handshake (server stream)
  "Read the first message from STREAM and check it.
Return true when it is an initialize call with the right token, after
replying to it.  Otherwise reply with +UNAUTHORIZED+ and return NIL."
  (let ((request (read-message stream)))
    (cond ((eq request :eof) nil)
          ((and (equal (message-method request) "initialize")
                (token-valid-p server (initialize-token request)))
           (write-message stream
                          (make-response (message-id request)
                                         (make-object "name" "clide")))
           t)
          (t
           (server-log server "Rejected connection: bad handshake.")
           (write-message stream
                          (make-error-response
                           (response-id request) +unauthorized+
                           "Initialize with a valid token first."))
           nil))))

(defun serve-connection (server stream)
  "Handshake, then answer requests on STREAM until it closes.
The first message must be initialize with the token; otherwise reply
with +UNAUTHORIZED+ and close."
  (handler-case
      (when (handshake server stream)
        (loop :for request := (read-message stream)
              :until (eq request :eof)
              :do (let ((response (dispatch server request)))
                    (when response
                      (write-message stream response)))))
    (jsonrpc-error (condition)
      (ignore-errors
       (write-message stream
                      (make-error-response nil
                                           (jsonrpc-error-code condition)
                                           (jsonrpc-error-message
                                            condition)))))
    (error (condition)
      (server-log server "Connection closed: ~a" condition))))

(defun forget-connection (server socket)
  "Close SOCKET and remove it from the connection registry."
  (ignore-errors (socket-close socket))
  (with-lock-held ((server-lock server))
    (setf (server-connections server)
          (remove socket (server-connections server)))))

(defun spawn-connection (server socket)
  "Serve SOCKET in a new thread and record it in the registry.
Return the thread."
  (with-lock-held ((server-lock server))
    (push socket (server-connections server)))
  (make-thread (lambda ()
                 (unwind-protect
                      (serve-connection server (socket-stream socket))
                   (forget-connection server socket)))
               :name "clide-connection"))


;;; Lifecycle

(defun accept-loop (server listener)
  "Accept connections on LISTENER until the server is stopped."
  (handler-case
      (loop :for socket := (socket-accept
                            listener :element-type '(unsigned-byte 8))
            :do (if (server-listener server)
                    (spawn-connection server socket)
                    (progn (socket-close socket)
                           (return))))
    (error (condition)
      (when (server-listener server)
        (server-log server "Accept loop stopped: ~a" condition)))))

(defun start-server (server &key (host "127.0.0.1") (port 0))
  "Listen on HOST and PORT, accept in a background thread, and return
the actual port.  PORT 0 picks an ephemeral port."
  (when (server-listener server)
    (error "Server is already running."))
  (let ((listener (socket-listen host port
                                 :reuse-address t
                                 :element-type '(unsigned-byte 8))))
    (setf (server-listener server) listener
          (server-host server) host
          (server-port server) (get-local-port listener)
          (server-accept-thread server)
          (make-thread (lambda () (accept-loop server listener))
                       :name "clide-accept"))
    (server-port server)))

(defun stop-server (server)
  "Close the listener and every open connection."
  (let (listener thread)
    (with-lock-held ((server-lock server))
      (setf listener (server-listener server)
            thread (server-accept-thread server)
            (server-listener server) nil
            (server-accept-thread server) nil))
    (when listener
      ;; Closing a listener does not wake a blocked accept, so connect
      ;; to it once; the accept loop sees the server is stopped.
      (ignore-errors
       (socket-close (socket-connect (server-host server)
                                     (server-port server))))
      (when (and thread (not (eq thread (current-thread))))
        (ignore-errors (join-thread thread)))
      (ignore-errors (socket-close listener)))
    (dolist (socket (with-lock-held ((server-lock server))
                      (copy-list (server-connections server))))
      (ignore-errors (socket-close socket)))
    nil))
