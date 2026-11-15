(defpackage :clide/lib/ansi-color
  (:use :cl)
  (:import-from :cl-ppcre
                #:regex-replace-all)
  (:import-from :trivial-gray-streams
                #:fundamental-character-output-stream
                #:stream-write-string
                #:stream-write-char)
  ;; Class/Methods
  (:export #:colored-stream
           #:target
           #:use-colors
           #:use-colors-p)
  ;; API
  (:export #:with-colored-output
           #:color
           #:arrow
           #:strip-ansi
           #:*use-unicode-arrows*)
  (:documentation "ANSI Color support for CLI."))

(in-package :clide/lib/ansi-color)


;;; Code:

(defun concat (&rest strings)
  "Shorthand for CONCATENATE specialized for strings."
  (apply #'concatenate 'string strings))


;;; ANSI Color Support

(defparameter *esc* (string (code-char 27))
  "ANSI escape character as a string.")

(defparameter *color-codes*
  `((:reset   . ,(concat *esc* "[0m"))
    (:bold    . ,(concat *esc* "[1m"))
    (:unbold  . ,(concat *esc* "[22m"))
    (:red     . ,(concat *esc* "[31m"))
    (:green   . ,(concat *esc* "[32m"))
    (:yellow  . ,(concat *esc* "[33m"))
    (:blue    . ,(concat *esc* "[34m"))
    (:magenta . ,(concat *esc* "[35m"))
    (:cyan    . ,(concat *esc* "[36m"))
    (:silver  . ,(concat *esc* "[37m"))
    (:grey    . ,(concat *esc* "[90m"))
    (:arrow   . " → "))
  "Direct keyword → ANSI escape code")

(defparameter *use-unicode-arrows* t
  "Use Unicode arrows (→) when T and terminal supports it.")

(defun color (&rest commands)
  "Return concatenated ANSI codes for COMMANDS."
  (apply #'concatenate 'string
         (mapcar (lambda (c) (or (cdr (assoc c *color-codes*)) "")) commands)))

(defun arrow ()
  "Return arrow string based on Unicode support."
  (if *use-unicode-arrows* (color :arrow) " -> "))

(defun strip-ansi (s)
  "Remove ANSI escape codes from string S."
  (regex-replace-all (concat *esc* "\\[[0-9;]*m") s ""))


;;; Modified Stream Class & Methods

(defclass colored-stream (fundamental-character-output-stream)
  ((target :initarg :target :reader target)
   (use-colors :initarg :use-colors :initform t :accessor use-colors-p))
  (:documentation "A Gray stream that adds ANSI colors to output."))

(defmethod stream-write-string
    ((stream colored-stream) string &optional start end)
  "Write STRING to target, stripping ANSI codes if colors disabled."
  (let ((text (subseq string (or start 0) end)))
    (write-string (if (use-colors-p stream) text (strip-ansi text))
                  (target stream))))

(defmethod stream-write-char ((stream colored-stream) char)
  "Fallback: write single character directly."
  (write-char char (target stream)))

;;; Terminal Support

(defun stdout-tty-p ()
  "Return true when standard output is a terminal.
Falls back to true when the check is unavailable."
  #+sbcl (eql 1 (sb-unix:unix-isatty 1))
  #+egcl (handler-case
             (not (zerop (egcl-ffi:foreign-call
                          (egcl-ffi:foreign-symbol-pointer "isatty")
                          :int '(:int) '(1))))
           (error () t))
  #-(or sbcl egcl) t)

(defun tty-colors-p ()
  "Return true when ANSI colors should be written to standard output."
  (and (not (uiop:getenv "NO_COLOR"))
       (stdout-tty-p)))


;;; API

(defmacro with-colored-output ((&key (use-colors '(tty-colors-p))) &body body)
  "Run BODY with *STANDARD-OUTPUT* wrapped in a COLORED-STREAM."
  `(let ((*standard-output*
           (make-instance 'colored-stream
                          :target *standard-output*
                          :use-colors ,use-colors)))
     ,@body))
