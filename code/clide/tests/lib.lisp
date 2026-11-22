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
                #:make-notification
                #:+parse-error+)
  (:import-from :clide/lib/parent
                #:wait-for-parent-exit)
  (:import-from :clide/lib/slynk-wire
                #:wire-error
                #:sym
                #:foreign-symbol-p
                #:foreign-symbol-name
                #:read-wire-string
                #:write-wire-string
                #:read-packet
                #:write-packet
                #:read-wire-message
                #:write-wire-message)
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

(test frame-crlf-default
  "A message frames the same where flexi-streams defaults to CRLF, as
on Windows: the header ends in one CR LF CR LF and nothing doubles."
  (let* ((flexi-streams:*default-eol-style* :crlf)
         (text (format nil "a~%b"))
         (octets (written-octets (make-response 1 text))))
    (is (null (search #(13 13) octets)))
    (is (search #(13 10 13 10) octets))
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

(test notification-shape
  "A notification has a method and params but no id."
  (let ((message (make-notification "ide/output" (make-object "text" "x"))))
    (is (string= "ide/output" (message-method message)))
    (is (null (message-id message)))
    (is (string= "x" (gethash "text" (message-params message))))))


;;; Slynk wire protocol

(defun wire-octets (text)
  "Return the octets of TEXT, UTF-8 encoded."
  (string-to-octets text :external-format :utf-8))

(defun packet-octets (header text)
  "Return HEADER, a string, followed by TEXT as UTF-8, as octets."
  (concatenate '(vector (unsigned-byte 8))
               (string-to-octets header :external-format :latin-1)
               (wire-octets text)))

(defun wire-error-p (thunk)
  "Return true when calling THUNK signals a WIRE-ERROR."
  (handler-case (progn (funcall thunk) nil)
    (wire-error () t)))

(test wire-read-reply
  "A return message reads as nested lists, keywords and numbers."
  (is (equal '(:return (:ok ("a" 1 -2 nil t)) 7)
             (read-wire-string "(:return (:ok (\"a\" 1 -2 nil t)) 7)"))))

(test wire-read-case
  "Keyword names are upcased and NIL and T are accepted in any case."
  (is (equal '(:lisp-implementation nil t)
             (read-wire-string "(:lisp-implementation NIL T)"))))

(test wire-read-floats
  "Floats read as numbers, never as symbols."
  (is (= 1.5d0 (first (read-wire-string "(1.5)"))))
  (is (= 100d0 (first (read-wire-string "(1d2)"))))
  (is (= 1/2 (first (read-wire-string "(1/2)")))))

(test wire-read-dotted
  "A dotted pair reads as a cons."
  (is (equal '(1 . 2) (read-wire-string "(1 . 2)")))
  (is (equal '(1 2 . 3) (read-wire-string "(1 2 . 3)"))))

(test wire-read-string-escapes
  "Quotes and backslashes are unescaped."
  (is (string= "a\"b\\c"
               (read-wire-string "\"a\\\"b\\\\c\""))))

(test wire-read-foreign-symbol
  "A symbol that is not a keyword is kept as its printed name."
  (let ((form (first (read-wire-string "(slynk:connection-info)"))))
    (is (foreign-symbol-p form))
    (is (string= "slynk:connection-info" (foreign-symbol-name form)))))

(test wire-read-no-evaluation
  "Reader macros are not run and unknown packages are no problem."
  (is (foreign-symbol-p (read-wire-string "no-such-package:thing")))
  (is (wire-error-p (lambda ()
                      (read-wire-string "#.(error \"no\")")))))

(test wire-read-bad-text
  "Malformed text signals WIRE-ERROR."
  (dolist (text '("" "(" "(1 2" ")" "\"open" "(1 . 2 3)" "(. 1)" "1 2"))
    (is (wire-error-p (lambda () (read-wire-string text))))))

(test wire-write-request
  "A request prints in the syntax slynk reads."
  (is (string= "(:emacs-rex (slynk:ping 1) nil t 5)"
               (write-wire-string
                `(:emacs-rex (,(sym "slynk:ping") 1) nil t 5)))))

(test wire-write-string-escapes
  "Quotes and backslashes in strings are escaped."
  (is (string= "\"a\\\"b\\\\c\"" (write-wire-string "a\"b\\c"))))

(test wire-write-dotted
  "A dotted pair prints with a dot."
  (is (string= "(1 2 . 3)" (write-wire-string '(1 2 . 3)))))

(test wire-write-unwritable
  "Data with no wire form signals WIRE-ERROR."
  (is (wire-error-p (lambda () (write-wire-string 1.5))))
  (is (wire-error-p (lambda () (write-wire-string 'plain-symbol)))))

(test wire-round-trip
  "What is written reads back as the same data."
  (let ((form '(:emacs-rex (:a "x y" 3 nil t) "CL-USER" 12 (1 . 2))))
    (is (equal form (read-wire-string (write-wire-string form))))))

(test wire-packet-round-trip
  "A packet carries multibyte text with a byte count header."
  (let* ((text (format nil "(:write-string \"caf~c ~c\")"
                       (code-char #xe9) (code-char #x3bb)))
         (octets (with-output-to-sequence (out)
                   (write-packet out text))))
    (is (string= (format nil "~6,'0x" (length (wire-octets text)))
                 (map 'string #'code-char (subseq octets 0 6))))
    (is (string= text (read-packet (octets-stream octets))))))

(test wire-packet-crlf-default
  "A packet counts and carries a line feed as one octet where
flexi-streams defaults to CRLF, as on Windows."
  (let* ((flexi-streams:*default-eol-style* :crlf)
         (text (format nil "(:write-string \"a~%b\")"))
         (octets (with-output-to-sequence (out)
                   (write-packet out text))))
    (is (string= (format nil "~6,'0x" (length text))
                 (map 'string #'code-char (subseq octets 0 6))))
    (is (null (find 13 octets)))
    (is (string= text (read-packet (octets-stream octets))))))

(test wire-packet-header-case
  "The hexadecimal header may be upper or lower case."
  (let ((text (make-string 26 :initial-element #\a)))
    (is (string= text (read-packet
                       (octets-stream (packet-octets "00001a" text)))))
    (is (string= text (read-packet
                       (octets-stream (packet-octets "00001A" text)))))))

(test wire-packet-eof
  "An empty stream reads as :EOF."
  (is (eq :eof (read-packet (octets-stream #()))))
  (is (eq :eof (read-wire-message (octets-stream #())))))

(test wire-packet-bad
  "A bad header or a short body signals WIRE-ERROR."
  (is (wire-error-p (lambda ()
                      (read-packet (octets-stream
                                    (packet-octets "00000g" ""))))))
  (is (wire-error-p (lambda ()
                      (read-packet (octets-stream
                                    (packet-octets "000009" "abc")))))))

(test wire-message-round-trip
  "A message survives write-wire-message and read-wire-message."
  (let ((form '(:return (:ok ("out" "42")) 3))
        (octets nil))
    (setf octets (with-output-to-sequence (out)
                   (write-wire-message out form)))
    (is (equal form (read-wire-message (octets-stream octets))))))

(test parent-exit-is-the-end-of-input
  "Waiting returns once the input ends, whatever was written first."
  (is (null (wait-for-parent-exit (make-string-input-stream ""))))
  (is (null (wait-for-parent-exit (make-string-input-stream "abc")))))
