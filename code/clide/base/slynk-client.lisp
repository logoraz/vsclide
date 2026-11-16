(defpackage :clide/base/slynk-client
  (:use :cl)
  (:import-from :bordeaux-threads
                #:make-lock
                #:make-thread
                #:current-thread
                #:thread-alive-p
                #:with-lock-held
                #:make-condition-variable
                #:condition-wait
                #:condition-notify)
  (:import-from :usocket
                #:socket-connect
                #:socket-close
                #:socket-shutdown
                #:socket-stream)
  (:import-from :clide/lib/slynk-wire
                #:read-wire-message
                #:write-wire-message
                #:write-packet)
  ;; Conditions
  (:export #:slynk-error
           #:slynk-error-message)
  ;; Connection
  (:export #:connect-client
           #:close-client
           #:client-open-p)
  ;; Calls and channels
  (:export #:client-rex
           #:client-call
           #:open-channel
           #:close-channel
           #:channel-send
           #:client-interrupt)
  (:documentation "Client side of the slynk protocol, over one socket."))

(in-package :clide/base/slynk-client)


;;; Code:
;;;
;;; Threads.  One reader thread per client reads every message and runs
;;; the reply callbacks, channel handlers and the event function, so
;;; those must not block and must not call CLIENT-CALL, which waits for
;;; a reply only the reader thread can deliver.  Any other thread may
;;; call CLIENT-CALL, CLIENT-REX and CHANNEL-SEND.

(define-condition slynk-error (error)
  ((message :initarg :message :reader slynk-error-message))
  (:report (lambda (condition stream)
             (write-string (slynk-error-message condition) stream)))
  (:documentation "A slynk call failed or the connection is unusable."))

(defun fail (control &rest args)
  "Signal a SLYNK-ERROR with a message made from CONTROL and ARGS."
  (error 'slynk-error :message (apply #'format nil control args)))

(defun ignore-log (control &rest args)
  "Discard a log message.  The default LOG-FN of a client."
  (declare (ignore control args))
  nil)

(defstruct (client (:constructor %make-client))
  "A connection to a slynk server."
  socket
  stream
  (write-lock (make-lock "slynk-client-write"))
  (lock (make-lock "slynk-client"))
  (pending (make-hash-table) :type hash-table)
  (channels (make-hash-table) :type hash-table)
  (next-id 1 :type integer)
  (next-channel 1 :type integer)
  (event-fn nil)
  (log-fn #'ignore-log :type function)
  (closed nil)
  (reader nil))

(defun client-open-p (client)
  "Return true while CLIENT can still be used."
  (not (client-closed client)))


;;; Sending

(defun send-form (client form)
  "Write FORM to the server, one writer at a time.
Signals SLYNK-ERROR when the connection is closed or cannot be written."
  (when (client-closed client)
    (fail "not connected to slynk"))
  (handler-case
      (with-lock-held ((client-write-lock client))
        (write-wire-message (client-stream client) form))
    (error (condition)
      (fail "cannot write to slynk: ~a" condition))))

(defun client-rex (client form callback &key package (thread t))
  "Ask the server to evaluate FORM, a wire form, and return the id.
CALLBACK is called later, in the reader thread, with a status and a
value.  The status is :OK with the result, :ABORT with the server's
message, :INVALID with the server's message, or :CLOSED with the
reason when the connection ends first.  PACKAGE is a package name or
NIL; THREAD is T, :REPL-THREAD or a thread id."
  (let ((id (with-lock-held ((client-lock client))
              (when (client-closed client)
                (fail "not connected to slynk"))
              (let ((id (client-next-id client)))
                (incf (client-next-id client))
                (setf (gethash id (client-pending client)) callback)
                id))))
    (handler-case
        (send-form client `(:emacs-rex ,form ,package ,thread ,id))
      (slynk-error (condition)
        (with-lock-held ((client-lock client))
          (remhash id (client-pending client)))
        (error condition)))
    id))

(defun client-call (client form &key package (thread t) (timeout 30))
  "Evaluate FORM on the server and return its value.
Signals SLYNK-ERROR when the server aborts the evaluation, the
connection closes, or TIMEOUT seconds pass without a reply.  A TIMEOUT
of NIL waits for ever."
  (let ((lock (make-lock "slynk-call"))
        (condition (make-condition-variable))
        (done nil)
        (status nil)
        (value nil))
    (client-rex client form
                (lambda (new-status new-value)
                  (with-lock-held (lock)
                    (setf status new-status
                          value new-value
                          done t)
                    (condition-notify condition)))
                :package package
                :thread thread)
    (let ((deadline (and timeout
                         (+ (get-internal-real-time)
                            (* timeout internal-time-units-per-second)))))
      (with-lock-held (lock)
        (loop :until done
              :do (let ((left (and deadline
                                   (/ (- deadline (get-internal-real-time))
                                      internal-time-units-per-second))))
                    (when (and left (<= left 0))
                      (fail "no reply from slynk after ~d seconds" timeout))
                    (condition-wait condition lock :timeout left)))))
    (ecase status
      (:ok value)
      (:abort (fail "~a" value))
      (:invalid (fail "slynk rejected the call: ~a" value))
      (:closed (fail "connection to slynk closed: ~a" value)))))


;;; Channels
;;;
;;; A channel carries messages between one object on the server and one
;;; handler here.  The ids on this side are ours; the server has its
;;; own, which OPEN-CHANNEL's caller learns from the call that makes the
;;; server object and passes to CHANNEL-SEND.

(defun open-channel (client handler)
  "Register HANDLER and return the new channel id.
HANDLER is called in the reader thread with a selector keyword and the
list of arguments of each message the server sends to the channel."
  (with-lock-held ((client-lock client))
    (let ((id (client-next-channel client)))
      (incf (client-next-channel client))
      (setf (gethash id (client-channels client)) handler)
      id)))

(defun close-channel (client id)
  "Forget the handler for channel ID."
  (with-lock-held ((client-lock client))
    (remhash id (client-channels client))))

(defun channel-send (client server-id selector &rest args)
  "Send the message SELECTOR with ARGS to the server channel SERVER-ID."
  (send-form client `(:emacs-channel-send ,server-id (,selector ,@args))))

(defun client-interrupt (client thread-id)
  "Interrupt the server thread THREAD-ID, as a user would with C-c."
  (send-form client `(:emacs-interrupt ,thread-id)))


;;; Receiving

(defun take-pending (client id)
  "Remove and return the callback waiting for reply ID, or NIL."
  (with-lock-held ((client-lock client))
    (prog1 (gethash id (client-pending client))
      (remhash id (client-pending client)))))

(defun handle-return (client result id)
  "Pass the RESULT of call ID to its callback."
  (let ((callback (take-pending client id)))
    (when callback
      (case (and (consp result) (first result))
        (:ok (funcall callback :ok (second result)))
        (:abort (funcall callback :abort (second result)))
        (t (funcall callback :abort
                    (format nil "unexpected reply ~s" result)))))))

(defun handle-channel-send (client id message)
  "Deliver MESSAGE, a selector and arguments, to channel ID."
  (let ((handler (with-lock-held ((client-lock client))
                   (gethash id (client-channels client)))))
    (if (and handler (consp message) (keywordp (first message)))
        (funcall handler (first message) (rest message))
        (funcall (client-log-fn client)
                 "Message for unknown channel ~s: ~s" id message))))

(defun reply-for-prompt (client message)
  "Answer a request from the server for input that nobody can give.
Replying keeps the server thread from waiting for ever."
  (destructuring-bind (kind thread tag &rest more) message
    (declare (ignore more))
    (send-form client
               (if (eq kind :read-string)
                   `(:emacs-return-string ,thread ,tag "")
                   `(:emacs-return ,thread ,tag nil)))))

(defun handle-message (client message)
  "Dispatch one MESSAGE from the server."
  (unless (consp message)
    (return-from handle-message
      (funcall (client-log-fn client) "Odd message: ~s" message)))
  (case (first message)
    (:return
     (destructuring-bind (result id) (rest message)
       (handle-return client result id)))
    (:invalid-rpc
     (destructuring-bind (id text) (rest message)
       (let ((callback (take-pending client id)))
         (when callback
           (funcall callback :invalid text)))))
    (:channel-send
     (destructuring-bind (id inner) (rest message)
       (handle-channel-send client id inner)))
    (:ping
     (destructuring-bind (thread tag) (rest message)
       (send-form client `(:emacs-pong ,thread ,tag))))
    ((:y-or-n-p :read-from-minibuffer :read-string :eval)
     (reply-for-prompt client message))
    ((:invalid-channel :reader-error)
     (funcall (client-log-fn client) "Server complained: ~s" message))
    (t
     (let ((event-fn (client-event-fn client)))
       (when event-fn
         (funcall event-fn client message))))))


;;; Lifecycle

(defun finish-client (client reason)
  "Mark CLIENT closed, release its socket and fail waiting calls with
REASON, a string.  Safe to call more than once."
  (let ((callbacks '())
        (first-time nil))
    (with-lock-held ((client-lock client))
      (unless (client-closed client)
        (setf (client-closed client) t
              first-time t)
        (maphash (lambda (id callback)
                   (declare (ignore id))
                   (push callback callbacks))
                 (client-pending client))
        (clrhash (client-pending client))))
    ;; Shutting down first wakes a reader blocked on the socket; a bare
    ;; close does not.  Do it once only: a second shutdown could hit
    ;; another socket that has reused the descriptor.
    (when first-time
      (ignore-errors (socket-shutdown (client-socket client) :io))
      (ignore-errors (socket-close (client-socket client))))
    (dolist (callback callbacks)
      (ignore-errors (funcall callback :closed reason)))
    (when (and first-time (client-event-fn client))
      (ignore-errors
       (funcall (client-event-fn client) client (list :closed reason))))))

(defun read-loop (client)
  "Read and handle messages until the connection ends."
  (let ((reason "connection closed"))
    (unwind-protect
         (handler-case
             (loop :for message := (read-wire-message (client-stream client))
                   :until (eq message :eof)
                   :do (handler-case (handle-message client message)
                         (error (condition)
                           (funcall (client-log-fn client)
                                    "Could not handle ~s: ~a"
                                    message condition))))
           (error (condition)
             (unless (client-closed client)
               (setf reason (princ-to-string condition)))))
      (finish-client client reason))))

(defun slynk-secret ()
  "Return the first line of ~/.sly-secret, or NIL when there is none.
A server that finds this file wants it as the first packet."
  (with-open-file (in (merge-pathnames ".sly-secret"
                                       (user-homedir-pathname))
                      :if-does-not-exist nil)
    (and in (read-line in nil ""))))

(defun connect-client (host port &key event-fn log-fn)
  "Connect to the slynk server on HOST and PORT and return a client.
EVENT-FN, if given, is called in the reader thread with the client and
each server message that has no other home, such as (:write-string
\"text\"), and once with (:closed REASON) when the connection ends.
LOG-FN takes a format control and arguments."
  (let* ((socket (socket-connect host port
                                 :element-type '(unsigned-byte 8)))
         (client (%make-client :socket socket
                               :stream (socket-stream socket)
                               :event-fn event-fn
                               :log-fn (or log-fn #'ignore-log)))
         (secret (slynk-secret)))
    (handler-case
        (progn
          (when secret
            (write-packet (client-stream client) secret))
          (setf (client-reader client)
                (make-thread (lambda () (read-loop client))
                             :name "clide-slynk-reader")))
      (error (condition)
        (ignore-errors (socket-close socket))
        (fail "cannot start slynk connection: ~a" condition)))
    client))

(defun close-client (client)
  "Close CLIENT and give its reader thread a moment to finish."
  (finish-client client "closed by clide")
  (let ((reader (client-reader client)))
    (when (and reader (not (eq reader (current-thread))))
      (loop :repeat 40
            :while (thread-alive-p reader)
            :do (sleep 0.05)))))
