(defpackage :clide/lib/jsonrpc
  (:use :cl)
  (:import-from :com.inuoe.jzon
                #:parse
                #:stringify)
  (:import-from :flexi-streams
                #:octets-to-string
                #:string-to-octets)
  ;; Conditions
  (:export #:jsonrpc-error
           #:jsonrpc-error-code
           #:jsonrpc-error-message
           #:jsonrpc-error-data)
  ;; Error codes
  (:export #:+parse-error+
           #:+invalid-request+
           #:+method-not-found+
           #:+invalid-params+
           #:+internal-error+
           #:+unauthorized+)
  ;; API
  (:export #:raise
           #:read-message
           #:write-message
           #:make-object
           #:make-notification
           #:make-response
           #:make-error-response
           #:message-id
           #:message-method
           #:message-params)
  (:documentation "JSON-RPC 2.0 codec with Content-Length framing."))

(in-package :clide/lib/jsonrpc)


;;; Code:

(defconstant +parse-error+ -32700
  "Invalid JSON or framing.")

(defconstant +invalid-request+ -32600
  "Not a valid request object.")

(defconstant +method-not-found+ -32601
  "The method does not exist.")

(defconstant +invalid-params+ -32602
  "Invalid method parameters.")

(defconstant +internal-error+ -32603
  "Internal server error.")

(defconstant +unauthorized+ -32001
  "Missing or wrong session token.")

(defconstant +max-body-size+ (* 64 1024 1024)
  "Largest message body, in bytes, that READ-MESSAGE will accept.")

(defconstant +max-header-size+ 8192
  "Longest header line, in bytes, that READ-MESSAGE will accept.")

(define-condition jsonrpc-error (error)
  ((code :initarg :code :reader jsonrpc-error-code)
   (message :initarg :message :reader jsonrpc-error-message)
   (data :initarg :data :initform nil :reader jsonrpc-error-data))
  (:report (lambda (condition stream)
             (format stream "JSON-RPC error ~a: ~a"
                     (jsonrpc-error-code condition)
                     (jsonrpc-error-message condition))))
  (:documentation "Signalled for protocol-level failures."))

(defun raise (code message &optional data)
  "Signal a JSONRPC-ERROR with CODE, MESSAGE and optional DATA."
  (error 'jsonrpc-error :code code :message message :data data))


;;; Framing

(defun text->octets (string external-format)
  "Return the octets of STRING in EXTERNAL-FORMAT.  A line feed stays
one octet on every platform; flexi-streams would write CRLF on Windows."
  (string-to-octets string
                    :external-format (list external-format :eol-style :lf)))

(defun octets->text (octets external-format)
  "Return the string that OCTETS encode in EXTERNAL-FORMAT.  CRLF stays
two characters on every platform; flexi-streams would read it as LF on
Windows."
  (octets-to-string octets
                    :external-format (list external-format :eol-style :lf)))

(defun read-header-line (stream)
  "Read one header line from binary STREAM, without its line ending.
Return :EOF when the stream ends before the first byte of the line."
  (let ((bytes (make-array 0 :element-type '(unsigned-byte 8)
                             :adjustable t
                             :fill-pointer t)))
    (loop :for byte := (read-byte stream nil nil)
          :do (cond ((null byte)
                     (if (zerop (length bytes))
                         (return :eof)
                         (raise +parse-error+
                                "End of stream inside a header.")))
                    ((= byte 10)
                     (when (and (plusp (length bytes))
                                (= (aref bytes (1- (length bytes))) 13))
                       (vector-pop bytes))
                     (return
                       (octets->text
                        (coerce bytes '(simple-array (unsigned-byte 8) (*)))
                        :latin-1)))
                    ((>= (length bytes) +max-header-size+)
                     (raise +parse-error+ "Header line is too long."))
                    (t (vector-push-extend byte bytes))))))

(defun content-length-value (line)
  "Return the integer in header LINE if it is Content-Length, else NIL.
Signal a parse error when the value is not a non-negative integer."
  (let ((colon (position #\: line)))
    (when (and colon
               (string-equal "content-length"
                             (string-trim '(#\Space #\Tab)
                                          (subseq line 0 colon))))
      (let ((value (ignore-errors
                    (parse-integer line :start (1+ colon)))))
        (if (and value (>= value 0))
            value
            (raise +parse-error+ "Bad Content-Length value."))))))

(defun read-headers (stream)
  "Read the header block from STREAM and return the Content-Length.
Return :EOF when the stream ends before any header.  Signal a parse
error when the block ends without a Content-Length."
  (let ((length nil)
        (first-line t))
    (loop :for line := (read-header-line stream)
          :do (cond ((eq line :eof)
                     (if first-line
                         (return :eof)
                         (raise +parse-error+
                                "End of stream inside the headers.")))
                    ((zerop (length line))
                     (return (or length
                                 (raise +parse-error+
                                        "Missing Content-Length header."))))
                    (t (setf first-line nil)
                       (let ((value (content-length-value line)))
                         (when value
                           (setf length value))))))))

(defun read-body (stream length)
  "Read exactly LENGTH octets from STREAM and return them."
  (when (> length +max-body-size+)
    (raise +parse-error+ "Message body is too large."))
  (let* ((octets (make-array length :element-type '(unsigned-byte 8)))
         (count (read-sequence octets stream)))
    (when (< count length)
      (raise +parse-error+ "End of stream inside the message body."))
    octets))

(defun decode-body (octets)
  "Return the JSON value encoded in the UTF-8 octets OCTETS."
  (handler-case (parse (octets->text octets :utf-8))
    (error ()
      (raise +parse-error+ "Invalid JSON."))))

(defun read-message (stream)
  "Read one framed message from binary STREAM and return it parsed.
Return :EOF when the stream ends before a header.  Signal
JSONRPC-ERROR with +PARSE-ERROR+ on bad headers or bad JSON."
  (let ((length (read-headers stream)))
    (if (eq length :eof)
        :eof
        (decode-body (read-body stream length)))))

(defun write-message (stream message)
  "Write MESSAGE to binary STREAM with a Content-Length header, then
flush the stream."
  (let* ((body (text->octets (stringify message) :utf-8))
         (crlf (format nil "~c~c" #\Return #\Newline))
         (header (text->octets
                  (format nil "Content-Length: ~d~a~a"
                          (length body) crlf crlf)
                  :latin-1)))
    (write-sequence header stream)
    (write-sequence body stream)
    (finish-output stream)
    nil))


;;; Messages

(defun make-object (&rest pairs)
  "Return a JSON object built from PAIRS, alternating string keys and
values."
  (let ((table (make-hash-table :test #'equal)))
    (loop :for (key value) :on pairs :by #'cddr
          :do (setf (gethash key table) value))
    table))

(defun make-response (id result)
  "Return a JSON-RPC success response object for request ID.
A NIL RESULT is sent as JSON null."
  (make-object "jsonrpc" "2.0"
               "id" id
               "result" (or result 'null)))

(defun make-notification (method params)
  "Return a JSON-RPC notification object for METHOD with PARAMS.
A notification has no id and is never answered."
  (make-object "jsonrpc" "2.0"
               "method" method
               "params" (or params 'null)))

(defun make-error-response (id code message &optional data)
  "Return a JSON-RPC error response object for request ID.
A NIL ID is sent as JSON null; DATA is included only when given."
  (let ((error-object (make-object "code" code "message" message)))
    (when data
      (setf (gethash "data" error-object) data))
    (make-object "jsonrpc" "2.0"
                 "id" (or id 'null)
                 "error" error-object)))

(defun message-id (message)
  "Return the id of MESSAGE, or NIL for a notification."
  (and (hash-table-p message)
       (values (gethash "id" message))))

(defun message-method (message)
  "Return the method name of MESSAGE, or NIL if it has none."
  (let ((method (and (hash-table-p message)
                     (gethash "method" message))))
    (and (stringp method) method)))

(defun message-params (message)
  "Return the params of MESSAGE, or NIL if it has none."
  (and (hash-table-p message)
       (values (gethash "params" message))))
