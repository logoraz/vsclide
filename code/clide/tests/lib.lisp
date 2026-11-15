(defpackage :clide/tests/lib
  (:use :cl :5am)
  (:import-from :clide/tests/suite
                #:suite)
  (:import-from :flexi-streams
                #:make-in-memory-input-stream
                #:with-output-to-sequence
                #:string-to-octets)
  (:import-from :com.inuoe.jzon
                #:stringify)
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
                #:+parse-error+)
  (:export #:lib-suite)
  (:documentation "Tests for the lib module."))

(in-package :clide/tests/lib)


;;; Code:

(def-suite lib-suite
  :description "Tests for lib module."
  :in suite)

(in-suite lib-suite)

(defun frame (string)
  "Return STRING framed with a correct Content-Length header, as an
octet vector."
  (let* ((body (string-to-octets string :external-format :utf-8))
         (header (format nil "Content-Length: ~d~c~c~c~c" (length body)
                         #\Return #\Newline #\Return #\Newline)))
    (concatenate '(vector (unsigned-byte 8))
                 (string-to-octets header :external-format :latin-1)
                 body)))

(defun octets-stream (octets)
  "Return a binary input stream that reads OCTETS."
  (make-in-memory-input-stream octets))

(defun written-octets (message)
  "Return the octets WRITE-MESSAGE produces for MESSAGE."
  (with-output-to-sequence (out)
    (write-message out message)))

(defun parse-error-code-p (octets)
  "Return true when reading OCTETS signals a +PARSE-ERROR+."
  (handler-case (progn (read-message (octets-stream octets)) nil)
    (jsonrpc-error (condition)
      (= (jsonrpc-error-code condition) +parse-error+))))

(test frame-round-trip
  "A message written then read back is unchanged."
  (let* ((request (make-object "jsonrpc" "2.0" "id" 7 "method" "ping"
                               "params" (make-object "a" 1)))
         (copy (read-message (octets-stream (written-octets request)))))
    (is (= 7 (message-id copy)))
    (is (string= "ping" (message-method copy)))
    (is (= 1 (gethash "a" (message-params copy))))))

(test frame-multibyte
  "Content-Length counts bytes, so multibyte UTF-8 survives."
  (let* ((text (format nil "h~c~c~c" (code-char 233) (code-char 955)
                       (code-char 26085)))
         (message (make-response 1 text))
         (octets (written-octets message))
         (body-length (length (string-to-octets (stringify message)
                                                :external-format :utf-8)))
         (header (format nil "Content-Length: ~d" body-length)))
    (is (search (string-to-octets header :external-format :latin-1) octets))
    (is (string= text (gethash "result"
                               (read-message (octets-stream octets)))))))

(test read-eof
  "An empty stream returns :EOF."
  (is (eq :eof (read-message (octets-stream #())))))

(test read-bad-header
  "A missing Content-Length signals a parse error."
  (is (parse-error-code-p
       (string-to-octets (format nil "Foo: 1~c~c~c~c{}" #\Return #\Newline
                                 #\Return #\Newline)
                         :external-format :latin-1))))

(test read-bad-json
  "Invalid JSON in a valid frame signals a parse error."
  (is (parse-error-code-p (frame "{not json"))))

(test read-truncated-body
  "A body shorter than Content-Length signals a parse error."
  (let ((octets (frame "{\"id\":1}")))
    (is (parse-error-code-p (subseq octets 0 (- (length octets) 2))))))

(test error-response-shape
  "An error response carries code, message and a null id when absent."
  (let ((response (make-error-response nil -32601 "nope")))
    (is (eq 'null (gethash "id" response)))
    (is (= -32601 (gethash "code" (gethash "error" response))))))
