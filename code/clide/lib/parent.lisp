(defpackage :clide/lib/parent
  (:use :cl)
  (:export #:wait-for-parent-exit)
  (:documentation "Notice that the process that started this one is gone."))

(in-package :clide/lib/parent)


;;; Code:

(defun wait-for-parent-exit (&optional (stream *standard-input*))
  "Block until STREAM reaches end of file, then return.
The extension keeps this process's standard input open as a pipe and
never writes to it, so the end of file arrives when the extension
exits, however it exits.  This works the same on every platform.
Anything read from STREAM meanwhile is discarded."
  (loop :while (read-char stream nil nil)))
