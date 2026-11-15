(defpackage :clide
  (:use :cl)
  (:import-from :clide/base/server
                #:make-server
                #:register-method
                #:start-server)
  (:export #:main)
  (:documentation "Entry point for the clide process."))

(in-package :clide)


;;; Code:

(defun register-builtin-methods (server)
  "Register the built-in methods on SERVER, currently just ping."
  (register-method server "ping"
                   (lambda (params)
                     (declare (ignore params))
                     "pong")))

(defun log-to-stderr (control &rest args)
  "Write a formatted log line to standard error.
Standard output is reserved for the port announcement."
  (format *error-output* "clide: ~?~%" control args)
  (finish-output *error-output*))

(defun main ()
  "Read CLIDE_TOKEN, start the server on an ephemeral loopback port,
print one JSON line with the port to stdout, then block."
  (let ((token (uiop:getenv "CLIDE_TOKEN")))
    (when (or (null token) (zerop (length token)))
      (format *error-output* "clide: CLIDE_TOKEN is not set.~%")
      (uiop:quit 2))
    (let ((server (make-server :token token :log-fn #'log-to-stderr)))
      (register-builtin-methods server)
      (let ((port (start-server server)))
        (fresh-line)
        (format t "{\"port\":~d}~%" port)
        (finish-output)
        (loop (sleep 3600))))))
