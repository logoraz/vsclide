(defpackage :clide/lib/slynk-wire
  (:use :cl)
  (:import-from :flexi-streams
                #:octets-to-string
                #:string-to-octets)
  ;; Conditions
  (:export #:wire-error
           #:wire-error-message)
  ;; Foreign symbols
  (:export #:sym
           #:foreign-symbol
           #:foreign-symbol-p
           #:foreign-symbol-name)
  ;; S-expressions
  (:export #:read-wire-string
           #:write-wire-string)
  ;; Framing
  (:export #:read-packet
           #:write-packet
           #:read-wire-message
           #:write-wire-message)
  (:documentation "Slynk wire protocol: framed, printed S-expressions."))

(in-package :clide/lib/slynk-wire)


;;; Code:
;;;
;;; A slynk message is a 6 digit hexadecimal byte count followed by that
;;; many octets of UTF-8 text, which is one printed S-expression.  The
;;; reader below is deliberately not the Lisp reader: it never interns
;;; symbols, evaluates anything or fails on a package that is missing
;;; here, so it is safe for text from another Lisp image.
;;;
;;; Mapping to Lisp data:
;;;   list, dotted list    list, dotted list
;;;   string               string
;;;   integer, float       the same number
;;;   nil, t               NIL, T
;;;   :keyword             keyword, name upcased
;;;   any other symbol     FOREIGN-SYMBOL holding the printed name

(defconstant +max-packet-size+ #xffffff
  "Largest payload, in octets, that fits the 6 digit hexadecimal header.")

(define-condition wire-error (error)
  ((message :initarg :message :reader wire-error-message))
  (:report (lambda (condition stream)
             (format stream "Malformed slynk message: ~a"
                     (wire-error-message condition))))
  (:documentation "Signalled for bad framing or unreadable text."))

(defun wire-fail (control &rest args)
  "Signal a WIRE-ERROR with a message made from CONTROL and ARGS."
  (error 'wire-error :message (apply #'format nil control args)))

(defstruct (foreign-symbol (:constructor sym (name))
                           (:predicate foreign-symbol-p))
  "A symbol of the other Lisp, kept as the text it was printed with.
Use SYM to build one when writing, for example (sym \"slynk:ping\")."
  (name "" :type string))


;;; Reading

(defstruct (cursor (:constructor make-cursor (text)))
  "A position in the text being read."
  (text "" :type string)
  (pos 0 :type fixnum))

(defun peek (cursor &optional (offset 0))
  "Return the character OFFSET places ahead in CURSOR, or NIL."
  (let ((index (+ (cursor-pos cursor) offset)))
    (and (< index (length (cursor-text cursor)))
         (char (cursor-text cursor) index))))

(defun next (cursor)
  "Consume and return the next character of CURSOR, or NIL at the end."
  (let ((char (peek cursor)))
    (when char
      (incf (cursor-pos cursor)))
    char))

(defun whitespace-p (char)
  "Return true when CHAR separates tokens."
  (member char '(#\Space #\Tab #\Newline #\Return #\Page)))

(defun delimiter-p (char)
  "Return true when CHAR ends a token."
  (or (null char)
      (whitespace-p char)
      (member char '(#\( #\) #\" #\'))))

(defun skip-space (cursor)
  "Advance CURSOR past any whitespace."
  (loop :while (whitespace-p (peek cursor))
        :do (next cursor)))

(defun parse-string (cursor)
  "Read the rest of a string literal; the opening quote is consumed."
  (with-output-to-string (out)
    (loop
      (let ((char (next cursor)))
        (case char
          ((nil) (wire-fail "unterminated string"))
          (#\" (return))
          (#\\ (let ((escaped (next cursor)))
                 (unless escaped
                   (wire-fail "unterminated string"))
                 (write-char escaped out)))
          (t (write-char char out)))))))

(defun parse-token (cursor)
  "Read characters up to the next delimiter and return them."
  (with-output-to-string (out)
    (loop :until (delimiter-p (peek cursor))
          :do (write-char (next cursor) out))))

(defun number-token-p (token)
  "Return true when TOKEN looks like a number the Lisp reader accepts:
only digits, signs, a point, an exponent marker or a slash, with at
least one digit."
  (and (plusp (length token))
       (every (lambda (char) (find char "0123456789+-./eEdD")) token)
       (find (char token 0) "0123456789+-.")
       (find-if #'digit-char-p token)))

(defun parse-number (token)
  "Return the number TOKEN denotes, or NIL when it is not one."
  (when (number-token-p token)
    (let ((*read-eval* nil)
          (*read-default-float-format* 'double-float))
      (let ((value (ignore-errors (read-from-string token))))
        (and (numberp value) value)))))

(defun parse-atom (token)
  "Return the Lisp datum for the printed atom TOKEN."
  (cond ((string-equal token "nil") nil)
        ((string-equal token "t") t)
        ((and (> (length token) 1) (char= (char token 0) #\:))
         (intern (string-upcase (subseq token 1)) :keyword))
        ((parse-number token))
        (t (sym token))))

(defun dot-p (cursor)
  "Return true when CURSOR is at a lone dot, as in (a . b)."
  (and (eql (peek cursor) #\.)
       (delimiter-p (peek cursor 1))))

(defun parse-list (cursor)
  "Read the rest of a list; the opening parenthesis is consumed."
  (let ((items '())
        (tail nil))
    (loop
      (skip-space cursor)
      (let ((char (peek cursor)))
        (cond ((null char) (wire-fail "unterminated list"))
              ((char= char #\)) (next cursor) (return))
              ((dot-p cursor)
               (when (null items)
                 (wire-fail "dot at the start of a list"))
               (next cursor)
               (setf tail (parse-form cursor))
               (skip-space cursor)
               (unless (eql (next cursor) #\))
                 (wire-fail "more than one form after a dot"))
               (return))
              (t (push (parse-form cursor) items)))))
    (let ((list (nreverse items)))
      (when tail
        (setf (cdr (last list)) tail))
      list)))

(defun parse-form (cursor)
  "Read one form from CURSOR."
  (skip-space cursor)
  (let ((char (peek cursor)))
    (cond ((null char) (wire-fail "unexpected end of text"))
          ((char= char #\() (next cursor) (parse-list cursor))
          ((char= char #\)) (wire-fail "unexpected close parenthesis"))
          ((char= char #\") (next cursor) (parse-string cursor))
          ((char= char #\') (next cursor)
           (list (sym "quote") (parse-form cursor)))
          (t (parse-atom (parse-token cursor))))))

(defun read-wire-string (text)
  "Parse TEXT, one printed S-expression, and return it.
Signals WIRE-ERROR when TEXT is malformed or has trailing forms."
  (let* ((cursor (make-cursor text))
         (form (parse-form cursor)))
    (skip-space cursor)
    (when (peek cursor)
      (wire-fail "text after the form"))
    form))


;;; Writing

(defun write-string-literal (string stream)
  "Write STRING to STREAM as a quoted literal."
  (write-char #\" stream)
  (loop :for char :across string
        :do (when (member char '(#\" #\\))
              (write-char #\\ stream))
            (write-char char stream))
  (write-char #\" stream))

(defun write-form (form stream)
  "Print FORM to STREAM in the syntax slynk reads.
Signals WIRE-ERROR for data with no wire representation."
  (cond ((null form) (write-string "nil" stream))
        ((eq form t) (write-string "t" stream))
        ((keywordp form)
         (write-char #\: stream)
         (write-string (string-downcase (symbol-name form)) stream))
        ((integerp form) (format stream "~d" form))
        ((stringp form) (write-string-literal form stream))
        ((foreign-symbol-p form)
         (write-string (foreign-symbol-name form) stream))
        ((consp form)
         (write-char #\( stream)
         (write-form (car form) stream)
         (loop :for rest := (cdr form) :then (cdr rest)
               :while rest
               :do (cond ((consp rest)
                          (write-char #\Space stream)
                          (write-form (car rest) stream))
                         (t
                          (write-string " . " stream)
                          (write-form rest stream)
                          (return))))
         (write-char #\) stream))
        (t (wire-fail "cannot write ~s" form))))

(defun write-wire-string (form)
  "Return FORM printed as a string in the syntax slynk reads."
  (with-output-to-string (out)
    (write-form form out)))


;;; Framing

(defun read-exactly (stream count)
  "Read COUNT octets from binary STREAM.
Return :EOF when the stream ends before the first octet, and signal
WIRE-ERROR when it ends part way."
  (let* ((buffer (make-array count :element-type '(unsigned-byte 8)))
         (got (read-sequence buffer stream)))
    (cond ((= got count) buffer)
          ((zerop got) :eof)
          (t (wire-fail "stream ended after ~d of ~d octets" got count)))))

(defun parse-header (octets)
  "Return the byte count in the 6 octet hexadecimal header OCTETS."
  (let ((text (map 'string #'code-char octets)))
    (or (and (every (lambda (char) (digit-char-p char 16)) text)
             (parse-integer text :radix 16))
        (wire-fail "bad length header ~s" text))))

(defun text-octets (string external-format)
  "Return the octets of STRING in EXTERNAL-FORMAT.  A line feed stays
one octet on every platform; flexi-streams would write CRLF on Windows."
  (string-to-octets string
                    :external-format (list external-format :eol-style :lf)))

(defun octets-text (octets external-format)
  "Return the string that OCTETS encode in EXTERNAL-FORMAT.  CRLF stays
two characters on every platform; flexi-streams would read it as LF on
Windows."
  (octets-to-string octets
                    :external-format (list external-format :eol-style :lf)))

(defun read-packet (stream)
  "Read one framed packet from binary STREAM and return its text.
Return :EOF when the stream has ended."
  (let ((header (read-exactly stream 6)))
    (if (eq header :eof)
        :eof
        (let ((body (read-exactly stream (parse-header header))))
          (when (eq body :eof)
            (wire-fail "stream ended before the message body"))
          (handler-case (octets-text body :utf-8)
            (error () (wire-fail "message body is not UTF-8")))))))

(defun write-packet (stream text)
  "Write TEXT to binary STREAM as one framed packet, then flush."
  (let* ((body (text-octets text :utf-8))
         (size (length body)))
    (when (> size +max-packet-size+)
      (wire-fail "message of ~d octets is too long" size))
    (let ((header (text-octets (format nil "~6,'0x" size) :latin-1)))
      (write-sequence header stream)
      (write-sequence body stream)
      (finish-output stream))))

(defun read-wire-message (stream)
  "Read one message from binary STREAM and return it as Lisp data, or
:EOF when the stream has ended."
  (let ((text (read-packet stream)))
    (if (eq text :eof)
        :eof
        (read-wire-string text))))

(defun write-wire-message (stream form)
  "Write FORM to binary STREAM as one framed message."
  (write-packet stream (write-wire-string form)))
