(defpackage :clide/base/location
  (:use :cl)
  (:import-from :clide/lib/jsonrpc
                #:make-object)
  (:import-from :clide/base/ide
                #:json-value)
  (:export #:location-object)
  (:documentation "Slynk source locations as JSON objects."))

(in-package :clide/base/location)


;;; Code:
;;;
;;; Slynk describes a place in source as
;;;
;;;   (:LOCATION BUFFER POSITION HINTS)   or   (:ERROR MESSAGE)
;;;
;;; where BUFFER is (:FILE name), (:BUFFER name) or
;;; (:BUFFER-AND-FILE buffer name), and POSITION is (:POSITION n),
;;; (:OFFSET start n), (:LINE line column) or others.  Positions count
;;; characters from 1; an :OFFSET is the start of the compiled string
;;; plus the distance into it.  The object made here is
;;;
;;;   {file, buffer, position, line, column, snippet, error}
;;;
;;; with null for what the location does not tell.  Code compiled by
;;; ide/compile has a buffer, the file it was compiled from, and no file.

(defun location-file (buffer)
  "Return the file name in the slynk location BUFFER part, or NIL."
  (when (consp buffer)
    (case (first buffer)
      (:file (second buffer))
      (:buffer-and-file (third buffer)))))

(defun location-buffer (buffer)
  "Return the name of the buffer in the slynk location BUFFER part, or
NIL.  Code compiled from a string has a buffer, named by whoever asked
for the compilation, and no file."
  (when (consp buffer)
    (case (first buffer)
      (:buffer (second buffer))
      (:buffer-and-file (second buffer)))))

(defun location-hint (hints key)
  "Return the value of KEY in the location HINTS, or NIL."
  (and (listp hints)
       (evenp (length hints))
       (ignore-errors (getf hints key))))

(defun position-number (position)
  "Return the character position, counted from 1, that the slynk
POSITION names, or NIL when it names a line instead."
  (when (consp position)
    (case (first position)
      (:position (second position))
      (:offset (and (integerp (second position))
                    (integerp (third position))
                    (+ (second position) (third position)))))))

(defun location-object (location)
  "Return the JSON object for LOCATION, what slynk's
frame-source-location and find-definitions return."
  (case (and (consp location) (first location))
    (:location
     (destructuring-bind (buffer position &optional hints) (rest location)
       (let ((line-p (and (consp position) (eq (first position) :line))))
         (make-object
          "file" (json-value (location-file buffer))
          "buffer" (json-value (location-buffer buffer))
          "position" (json-value (position-number position))
          "line" (json-value (and line-p (second position)))
          "column" (json-value (and line-p (third position)))
          "snippet" (json-value (location-hint hints :snippet))
          "error" 'null))))
    (:error
     (make-object "file" 'null "buffer" 'null "position" 'null "line" 'null
                  "column" 'null "snippet" 'null
                  "error" (json-value (second location))))
    (t 'null)))
