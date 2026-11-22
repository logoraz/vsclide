(defpackage :clide/base/ide
  (:use :cl)
  (:import-from :bordeaux-threads
                #:make-lock
                #:with-lock-held)
  (:import-from :clide/lib/jsonrpc
                #:make-object
                #:raise
                #:+invalid-params+)
  (:import-from :clide/lib/slynk-wire
                #:sym
                #:foreign-symbol-p
                #:foreign-symbol-name)
  (:import-from :clide/base/slynk-client
                #:slynk-error
                #:connect-client
                #:close-client
                #:client-open-p
                #:client-rex
                #:client-call
                #:client-call-status
                #:client-interrupt
                #:open-channel
                #:close-channel
                #:channel-send)
  (:import-from :clide/base/server
                #:register-method
                #:broadcast)
  (:export #:register-ide-methods
           #:+not-connected+
           #:+slynk-failure+
           ;; For the modules that add methods
           #:ide
           #:ide-server
           #:ide-id
           #:require-client
           #:find-repl
           #:repl-server-id
           #:repl-thread-id
           #:register-ide-method
           #:register-event-handler
           #:param
           #:required-string
           #:optional-string
           #:required-integer
           #:optional-integer
           #:json-value
           #:json-array
           #:notify
           #:require-module
           #:ensure-stickers)
  (:documentation "IDE methods: connect to slynk, evaluate, REPLs."))

(in-package :clide/base/ide)


;;; Code:
;;;
;;; The methods registered here are what jekyl calls.  Requests:
;;;
;;; Every request below takes an optional connectionId, the connection it
;;; is for; left out, it means the only connection, and it is an error
;;; (invalid params) when several are open.  Every notification carries
;;; the connectionId of the connection it comes from.
;;;
;;;   ide/connect {host?, port, name?, connectionId?}
;;;                                      open a new connection, return its
;;;                                      connectionId, implementation info
;;;                                      and the features of the image;
;;;                                      with an open connectionId, replace
;;;                                      that connection
;;;   ide/disconnect                     drop a connection
;;;   ide/connections                    {connections: [{connectionId, name,
;;;                                      host, port}]}
;;;   ide/eval {code, package?, debug?}  evaluate, return output and value;
;;;                                      with debug, an error enters the
;;;                                      debugger and the call returns when
;;;                                      the debugger is left
;;;   ide/sylvesters                     {text}: slynk's sylvesters.txt, or null
;;;   ide/repl/create                    new REPL, return its id
;;;   ide/repl/send {replId, text}       give a REPL a line of input
;;;   ide/repl/interrupt {replId}        interrupt a running REPL evaluation
;;;   ide/repl/close {replId}            end a REPL
;;;   ide/repl/syncPackage {replId, package}
;;;       set the package of a REPL, as SLY's C-c ~ does; the new prompt
;;;       arrives as an ide/repl/prompt notification and is returned
;;;       as {package, nickname}
;;;
;;; Notifications, sent to every client:
;;;
;;;   ide/disconnected {reason}          the slynk connection ended
;;;   ide/output {text}                  output with no REPL to take it
;;;   ide/features {features}            the features of the image changed
;;;   ide/repl/output {replId, text}
;;;   ide/repl/prompt {replId, package, nickname, level, entry, condition}
;;;   ide/repl/values {replId, values: [{text, index, value}]}
;;;   ide/repl/aborted {replId, message}
;;;   ide/repl/readMode {replId, mode}
;;;   ide/repl/cleared {replId}
;;;
;;; Notifications for a REPL can arrive before the reply to
;;; ide/repl/create that tells the caller its id.

(defconstant +not-connected+ -32002
  "No slynk connection is open.")

(defconstant +slynk-failure+ -32003
  "Slynk could not be reached or refused the request.")

(defstruct (hub (:constructor make-hub (server)))
  "The connections of the IDE: the server to notify, the table of open
connections by id, and the slynk event handlers they share."
  server
  (lock (make-lock "clide-hub"))
  (connections (make-hash-table) :type hash-table)
  (next-id 1 :type integer)
  (handlers (make-hash-table) :type hash-table))

(defstruct (ide (:constructor make-ide (hub id name host port)))
  "One connection: its id and name, where it goes, the slynk client and
the REPLs open on it.  The IDE methods take one of these."
  hub
  id
  name
  host
  port
  (lock (make-lock "clide-ide"))
  (load-lock (make-lock "clide-ide-load"))
  (client nil)
  (repls (make-hash-table) :type hash-table))

(defun ide-server (ide)
  "Return the server that IDE notifies."
  (hub-server (ide-hub ide)))

(defstruct (repl (:constructor make-repl (server-id thread-id)))
  "A REPL: the slynk channel and thread behind a client side id."
  server-id
  thread-id)


;;; Parameters and JSON

(defun param (params name)
  "Return the value of NAME in the JSON object PARAMS, or NIL."
  (and (hash-table-p params)
       (values (gethash name params))))

(defun required-string (params name)
  "Return the string parameter NAME, or raise +INVALID-PARAMS+."
  (let ((value (param params name)))
    (if (stringp value)
        value
        (raise +invalid-params+ (format nil "~a must be a string." name)))))

(defun optional-string (params name)
  "Return the string parameter NAME, or NIL when absent or not a string."
  (let ((value (param params name)))
    (and (stringp value) value)))

(defun required-integer (params name)
  "Return the integer parameter NAME, or raise +INVALID-PARAMS+."
  (let ((value (param params name)))
    (if (integerp value)
        value
        (raise +invalid-params+ (format nil "~a must be an integer." name)))))

(defun optional-integer (params name)
  "Return the integer parameter NAME, or NIL when absent or not an
integer."
  (let ((value (param params name)))
    (and (integerp value) value)))

(defun json-value (value)
  "Return VALUE, read from slynk, in a form JSON can carry."
  (typecase value
    (null 'null)
    (string value)
    (number value)
    (keyword (string-downcase (symbol-name value)))
    (symbol (string-downcase (symbol-name value)))
    (t (if (foreign-symbol-p value)
           (foreign-symbol-name value)
           (princ-to-string value)))))

(defun json-array (list)
  "Return LIST as a vector, which JSON writes as an array even if empty."
  (coerce list 'simple-vector))

(defun feature-names (features)
  "Return the names in FEATURES, the list of features slynk sends, as a
vector of lower case strings."
  (json-array (loop :for feature :in (and (listp features) features)
                    :collect (json-value feature))))

(defun notify (ide method &rest pairs)
  "Notify every client of METHOD with an object made from PAIRS and the
connectionId of IDE."
  (broadcast (ide-server ide) method
             (apply #'make-object "connectionId" (ide-id ide) pairs)))


;;; Connection

(defun require-client (ide)
  "Return the open slynk client of IDE, or raise +NOT-CONNECTED+."
  (let ((client (with-lock-held ((ide-lock ide))
                  (ide-client ide))))
    (if (and client (client-open-p client))
        client
        (raise +not-connected+ "Not connected to slynk."))))

(defun connection-info-object (info)
  "Return the JSON object describing the plist INFO that slynk's
connection-info call returns."
  (flet ((field (plist key)
           (json-value (getf plist key))))
    (let ((implementation (getf info :lisp-implementation))
          (machine (getf info :machine))
          (package (getf info :package)))
      (make-object
       "implementation" (make-object
                         "type" (field implementation :type)
                         "name" (field implementation :name)
                         "version" (field implementation :version)
                         "program" (field implementation :program))
       "features" (feature-names (getf info :features))
       "pid" (field info :pid)
       "style" (field info :style)
       "machine" (make-object "instance" (field machine :instance)
                              "type" (field machine :type)
                              "version" (field machine :version))
       "package" (make-object "name" (field package :name)
                              "prompt" (field package :prompt))
       "protocolVersion" (field info :version)))))

(defun abort-debugger (client event)
  "Leave the debugger that slynk entered, as announced by EVENT.
Nobody can answer a debugger yet, and the thread would wait for ever."
  (let ((thread (second event)))
    (ignore-errors
     (client-rex client
                 (list (sym "slynk:throw-to-toplevel"))
                 (lambda (status value)
                   (declare (ignore status value))
                   nil)
                 :thread thread))))

;;; The table of connections

(defun find-connection (hub params)
  "Return the connection of HUB that PARAMS names by connectionId.  With
none named it is the only open connection.  Raise +NOT-CONNECTED+ when
there is none, or the one named is not open, and +INVALID-PARAMS+ when
several are open and none is named."
  (let ((id (optional-integer params "connectionId")))
    (with-lock-held ((hub-lock hub))
      (let ((table (hub-connections hub)))
        (cond (id (or (gethash id table)
                      (raise +not-connected+
                             (format nil "No connection ~d." id))))
              ((zerop (hash-table-count table))
               (raise +not-connected+ "Not connected to slynk."))
              ((= 1 (hash-table-count table))
               (loop :for ide :being :the :hash-values :of table
                     :return ide))
              (t (raise +invalid-params+
                        (format nil "connectionId is needed with ~
                                     several connections."))))))))

(defun forget-connection (ide)
  "Remove IDE from the table of its hub, and return its client, if any;
the REPLs go with it."
  (let ((hub (ide-hub ide)))
    (with-lock-held ((hub-lock hub))
      (when (eq ide (gethash (ide-id ide) (hub-connections hub)))
        (remhash (ide-id ide) (hub-connections hub))))
    (with-lock-held ((ide-lock ide))
      (prog1 (ide-client ide)
        (setf (ide-client ide) nil)
        (clrhash (ide-repls ide))))))

(defun connection-closed (ide client reason)
  "Forget CLIENT if it is still the client of IDE and tell jekyl."
  (let ((current (with-lock-held ((ide-lock ide))
                   (eq client (ide-client ide)))))
    (when current
      (forget-connection ide)
      (notify ide "ide/disconnected" "reason" reason))))

(defun register-event-handler (hub kind function)
  "Have FUNCTION handle the slynk events of KIND, a keyword, on every
connection of HUB.  It is called in the reader thread with the
connection and the event, and must not block."
  (setf (gethash kind (hub-handlers hub)) function))

(defun handle-event (ide client event)
  "Handle a slynk message of the connection IDE that belongs to no call
or channel.  A debugger event that nobody handles is aborted, since the
thread that entered the debugger would wait for ever."
  (let ((handler (gethash (first event) (hub-handlers (ide-hub ide)))))
    (cond (handler (funcall handler ide event))
          ((eq (first event) :closed)
           (connection-closed ide client (second event)))
          ((eq (first event) :new-features)
           (notify ide "ide/features"
                   "features" (feature-names (second event))))
          ((eq (first event) :write-string)
           (when (stringp (second event))
             (notify ide "ide/output" "text" (second event))))
          ((eq (first event) :debug) (abort-debugger client event))
          (t nil))))

(defun disconnect (ide)
  "Close the slynk connection IDE and forget it, without a
notification."
  (let ((client (forget-connection ide)))
    (when client
      (close-client client))))

(defun new-connection (hub params)
  "Return a connection for the ide/connect PARAMS: the one named by
connectionId, closed first, or a new one with the next free id."
  (let ((host (or (optional-string params "host") "127.0.0.1"))
        (port (required-integer params "port"))
        (id (optional-integer params "connectionId")))
    (let ((old (and id (with-lock-held ((hub-lock hub))
                         (gethash id (hub-connections hub))))))
      (when old
        (disconnect old)))
    (with-lock-held ((hub-lock hub))
      (let ((id (or id
                    (loop :for next := (hub-next-id hub)
                          :do (incf (hub-next-id hub))
                          :unless (gethash next (hub-connections hub))
                            :return next))))
        (setf (hub-next-id hub) (max (hub-next-id hub) (1+ id)))
        (make-ide hub id
                  (or (optional-string params "name")
                      (format nil "~a:~d" host port))
                  host port)))))

(defun connect (hub params)
  "Handle ide/connect: open a connection and return its id and the
implementation info."
  (let* ((ide (new-connection hub params))
         (host (ide-host ide))
         (port (ide-port ide))
         (client (handler-case
                     (connect-client
                      host port
                      :event-fn (lambda (client event)
                                  (handle-event ide client event)))
                   (error (condition)
                     (raise +slynk-failure+
                            (format nil "Cannot connect to slynk on ~a:~d: ~a"
                                    host port condition))))))
    (handler-case
        (let ((info (client-call client
                                 (list (sym "slynk:connection-info")))))
          (with-lock-held ((ide-lock ide))
            (setf (ide-client ide) client))
          (with-lock-held ((hub-lock hub))
            (setf (gethash (ide-id ide) (hub-connections hub)) ide))
          (let ((object (connection-info-object info)))
            (setf (gethash "connectionId" object) (ide-id ide)
                  (gethash "name" object) (ide-name ide)
                  (gethash "host" object) host
                  (gethash "port" object) port)
            object))
      (slynk-error (condition)
        (close-client client)
        (raise +slynk-failure+
               (format nil "Slynk did not answer: ~a" condition))))))

(defun list-connections (hub params)
  "Handle ide/connections: describe the open connections, by id."
  (declare (ignore params))
  (let ((connections
          (with-lock-held ((hub-lock hub))
            (loop :for ide :being :the :hash-values :of (hub-connections hub)
                  :collect ide))))
    (make-object
     "connections"
     (json-array
      (loop :for ide :in (sort connections #'< :key #'ide-id)
            :collect (make-object "connectionId" (ide-id ide)
                                  "name" (ide-name ide)
                                  "host" (ide-host ide)
                                  "port" (ide-port ide)))))))


;;; Evaluation

(defun eval-form (code)
  "Return the wire form that evaluates the string CODE in slynk.
Errors are caught on the server, so no debugger is entered; the form
returns (:error TEXT) after one, else (OUTPUT VALUE-TEXT).  Numbers
print plain, without the bit counts and radixes slynk adds for an echo
area."
  (list (sym "cl:let")
        (list (list (sym "slynk::*echo-number-alist*") nil))
        (list (sym "cl:handler-case")
              (list (sym "slynk:eval-and-grab-output") code)
              (list (sym "cl:serious-condition")
                    (list (sym "c"))
                    (list (sym "cl:list") :error
                          (list (sym "cl:princ-to-string") (sym "c")))))))

(defun debug-eval-form (code)
  "Return the wire form that evaluates the string CODE in slynk with
the debugger enabled: an error enters it, as in SLY.  The form returns
(OUTPUT VALUE-TEXT), numbers printed plain."
  (list (sym "cl:let")
        (list (list (sym "slynk::*echo-number-alist*") nil))
        (list (sym "slynk:eval-and-grab-output") code)))

(defun eval-result-object (result)
  "Return the JSON object for RESULT, what EVAL-FORM's form returned."
  (if (and (consp result) (eq (first result) :error))
      (make-object "ok" nil
                   "error" (json-value (second result))
                   "output" ""
                   "value" 'null)
      (make-object "ok" t
                   "error" 'null
                   "output" (json-value (first result))
                   "value" (json-value (second result)))))

(defun evaluate (ide params)
  "Handle ide/eval: evaluate code in slynk and return what it printed
and the printed value.  A Lisp error is a normal reply with ok false.
With the debug parameter an error enters the debugger instead and the
call returns when the debugger is left, ok false with slynk's message."
  (let ((code (required-string params "code"))
        (package (optional-string params "package"))
        (debug (param params "debug"))
        (client (require-client ide)))
    (handler-case
        (if (eq debug t)
            (debug-evaluate client code package)
            (eval-result-object
             (client-call client (eval-form code)
                          :package package
                          :timeout nil)))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))

(defun debug-evaluate (client code package)
  "Evaluate CODE on CLIENT with the debugger enabled.  Leaving the
debugger by an abort ends the evaluation; that is a reply with ok false,
not a failure, unless the connection itself is gone."
  (multiple-value-bind (status value)
      (client-call-status client (debug-eval-form code)
                          :package package :timeout nil)
    (case status
      (:ok (eval-result-object value))
      (:abort (make-object "ok" nil
                           "error" (json-value value)
                           "output" ""
                           "value" 'null))
      (t (error 'slynk-error
                :message (format nil "~a" value))))))

(defun sylvesters-form ()
  "Return the form that reads sylvesters.txt in the slynk image.  The
file sits in the contrib directory next to the slynk system, and is
read from the user's own install, never copied.  Evaluates to the
text, or NIL when the file cannot be found."
  (list (sym "cl:ignore-errors")
        (list (sym "cl:with-open-file")
              (list (sym "s")
                    (list (sym "cl:merge-pathnames")
                          "../contrib/sylvesters.txt"
                          (list (sym "asdf:system-source-directory")
                                "slynk"))
                    :external-format :utf-8)
              (list (sym "cl:let")
                    (list (list (sym "text")
                                (list (sym "cl:make-string")
                                      (list (sym "cl:file-length")
                                            (sym "s")))))
                    (list (sym "cl:subseq")
                          (sym "text")
                          0
                          (list (sym "cl:read-sequence")
                                (sym "text")
                                (sym "s")))))))

(defun sylvesters (ide params)
  "Handle ide/sylvesters: return the text of slynk's sylvesters.txt, or
null when this slynk install has none."
  (declare (ignore params))
  (let ((text (handler-case
                  (client-call (require-client ide) (sylvesters-form))
                (slynk-error () nil))))
    (make-object "text" (if (stringp text) text 'null))))


;;; REPLs

(defun mrepl-loaded-p (client)
  "Return true when the mrepl contrib is loaded in the slynk of CLIENT."
  (client-call client
               (list (sym "cl:and")
                     (list (sym "cl:find-package") "SLYNK-MREPL")
                     t)))

(defun require-module (client module)
  "Ask slynk to load MODULE, ignoring failure; the caller checks."
  (handler-case
      (client-call client
                   (list (sym "slynk:slynk-require")
                         (list (sym "quote") (list module)))
                   :timeout 300)
    (slynk-error () nil)))

(defun ensure-mrepl (ide client)
  "Load slynk's mrepl contrib into the server of CLIENT unless it is
there.  Slynk names it slynk/mrepl as an ASDF system and slynk-mrepl
through its own loader, so both are tried."
  (with-lock-held ((ide-load-lock ide))
    (unless (mrepl-loaded-p client)
      (dolist (module '("slynk/mrepl" "slynk-mrepl"))
        (require-module client module)
        (when (mrepl-loaded-p client)
          (return)))
      (unless (mrepl-loaded-p client)
        (raise +slynk-failure+
               "Slynk could not load the mrepl contrib.")))))

(defparameter *breakpoint-helper*
  "(defun clide-image::break-here (id)
  \"Enter the debugger just before the sticker ID, a breakpoint.\"
  (let ((sticker (gethash id slynk-stickers::*stickers*)))
    (when sticker
      (slynk-stickers::invoke-debugger-for-sticker
       sticker
       (make-condition 'slynk-stickers::just-before-sticker
                       :sticker sticker
                       :debugger-extra-options
                       (list (list :clide-breakpoint id)))))))"
  "The source of the function the image calls at a breakpoint.  It is
read after the stickers contrib is there, for its symbols.")

(defun stickers-loaded-p (client)
  "Return true when the stickers contrib and the breakpoint helper are
in the image of CLIENT."
  (client-call client
               (list (sym "cl:and")
                     (list (sym "cl:find-package") "SLYNK-STICKERS")
                     (list (sym "cl:find-package") "CLIDE-IMAGE")
                     (list (sym "cl:fboundp")
                           (list (sym "cl:find-symbol") "BREAK-HERE"
                                 "CLIDE-IMAGE"))
                     t)))

(defun ensure-stickers (ide client)
  "Load slynk's stickers contrib into the server of CLIENT, with the
function breakpoints call, unless they are there."
  (with-lock-held ((ide-load-lock ide))
    (unless (stickers-loaded-p client)
      (dolist (module '("slynk/stickers" "slynk-stickers"))
        (require-module client module)
        (when (client-call client
                           (list (sym "cl:and")
                                 (list (sym "cl:find-package")
                                       "SLYNK-STICKERS")
                                 t))
          (return)))
      (handler-case
          (progn
            (client-call client
                         (list (sym "cl:or")
                               (list (sym "cl:find-package") "CLIDE-IMAGE")
                               (list (sym "cl:make-package") "CLIDE-IMAGE"
                                     :use (list (sym "quote")
                                                (list "COMMON-LISP")))))
            (client-call client
                         (list (sym "cl:eval")
                               (list (sym "cl:read-from-string")
                                     *breakpoint-helper*))))
        (slynk-error ()
          (raise +slynk-failure+
                 "Slynk could not load the stickers contrib."))))
    (unless (stickers-loaded-p client)
      (raise +slynk-failure+ "Slynk could not load the stickers contrib."))))

(defun notify-repl (ide id method &rest pairs)
  "Notify clients of METHOD for REPL ID, with extra PAIRS."
  (apply #'notify ide method "replId" id pairs))

(defun repl-values-array (values)
  "Return the JSON array for the :write-values payload VALUES, a list
of (TEXT ENTRY-INDEX SHORT-TEXT).  Each element has the printed text,
the history entry it belongs to (index), and its place among the values
of that entry (value), which together name it for ide/inspect/replValue."
  (json-array
   (loop :for entry :in values
         :for position :from 0
         :collect (make-object "text" (json-value (first entry))
                               "index" (json-value (second entry))
                               "value" position))))

(defun notify-prompt (ide id args)
  "Send the ide/repl/prompt notification of REPL ID for ARGS, the
arguments of a slynk prompt: (PACKAGE NICKNAME LEVEL ENTRY CONDITION)."
  (destructuring-bind (package nickname level entry &optional condition)
      args
    (notify-repl ide id "ide/repl/prompt"
                 "package" (json-value package)
                 "nickname" (json-value nickname)
                 "level" (json-value level)
                 "entry" (json-value entry)
                 "condition" (json-value condition))))

(defun handle-repl-message (ide id selector args)
  "Turn the message SELECTOR with ARGS for REPL ID into a notification."
  (case selector
    (:write-string
     (notify-repl ide id "ide/repl/output" "text" (json-value (first args))))
    (:prompt
     (notify-prompt ide id args))
    (:write-values
     (notify-repl ide id "ide/repl/values"
                  "values" (repl-values-array (first args))))
    (:evaluation-aborted
     (notify-repl ide id "ide/repl/aborted"
                  "message" (json-value (first args))))
    (:set-read-mode
     (notify-repl ide id "ide/repl/readMode"
                  "mode" (json-value (first args))))
    (:clear-repl-history
     (notify-repl ide id "ide/repl/cleared"))
    (t nil)))

(defun find-repl (ide params)
  "Return the REPL named by the replId parameter, or raise."
  (let* ((id (required-integer params "replId"))
         (repl (with-lock-held ((ide-lock ide))
                 (gethash id (ide-repls ide)))))
    (or repl
        (raise +invalid-params+ (format nil "No REPL ~d." id)))))

(defun create-repl (ide params)
  "Handle ide/repl/create: open a REPL on the slynk server and return
its id.  The first prompt arrives as a notification."
  (declare (ignore params))
  (let ((client (require-client ide)))
    (ensure-mrepl ide client)
    (let* ((id nil)
           (channel (open-channel
                     client
                     (lambda (selector args)
                       (handle-repl-message ide id selector args)))))
      (setf id channel)
      (handler-case
          (destructuring-bind (server-id thread-id)
              (client-call client
                           (list (sym "slynk-mrepl:create-mrepl") id))
            (with-lock-held ((ide-lock ide))
              (setf (gethash id (ide-repls ide))
                    (make-repl server-id thread-id)))
            (make-object "replId" id))
        (slynk-error (condition)
          (close-channel client id)
          (raise +slynk-failure+ (princ-to-string condition)))))))

(defun send-to-repl (ide params)
  "Handle ide/repl/send: give the REPL a line of input."
  (let ((repl (find-repl ide params))
        (text (required-string params "text"))
        (client (require-client ide)))
    (handler-case (channel-send client (repl-server-id repl) :process text)
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))
    nil))

(defun interrupt-repl (ide params)
  "Handle ide/repl/interrupt: interrupt the thread of the REPL."
  (let ((repl (find-repl ide params))
        (client (require-client ide)))
    (handler-case (client-interrupt client (repl-thread-id repl))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))
    nil))

(defun close-repl (ide params)
  "Handle ide/repl/close: tear the REPL down on both sides."
  (let* ((id (required-integer params "replId"))
         (repl (find-repl ide params))
         (client (require-client ide)))
    (with-lock-held ((ide-lock ide))
      (remhash id (ide-repls ide)))
    (ignore-errors (channel-send client (repl-server-id repl) :teardown))
    (close-channel client id)
    nil))


(defun sync-repl-package (ide params)
  "Handle ide/repl/syncPackage: make PACKAGE the package of the REPL
replId, in the thread of the REPL, as slynk requires.  The reply names
the package and its nickname; the page gets the new prompt."
  (let ((repl (find-repl ide params))
        (package (required-string params "package"))
        (id (required-integer params "replId"))
        (client (require-client ide)))
    (handler-case
        (let* ((known (client-call
                       client
                       (list (sym "cl:if")
                             (list (sym "slynk::guess-package") package)
                             t nil)
                       :timeout 30))
               (reply (progn
                        (unless known
                          (raise +slynk-failure+
                                 (format nil "No package ~a." package)))
                        (client-call
                         client
                         (list (sym "slynk-mrepl:eval-for-mrepl")
                               (repl-server-id repl)
                               (list (sym "quote")
                                     (sym "slynk-mrepl:guess-and-set-package"))
                               package)
                         :thread (repl-thread-id repl)
                         :timeout 30)))
               (prompt (first reply)))
          (notify-prompt ide id prompt)
          (make-object "package" (json-value (first prompt))
                       "nickname" (json-value (second prompt))))
      (slynk-error (condition)
        (raise +slynk-failure+ (princ-to-string condition))))))


;;; Registration

(defun register-ide-method (hub name function)
  "Register NAME on the server of HUB; FUNCTION takes the connection the
request names, and its params."
  (register-method (hub-server hub) name
                   (lambda (params)
                     (funcall function (find-connection hub params) params))))

(defun register-ide-methods (server)
  "Register the ide/ methods on SERVER and return the HUB of connections
they share.  Call this before the server starts."
  (let ((hub (make-hub server)))
    (register-method server "ide/connect"
                     (lambda (params) (connect hub params)))
    (register-method server "ide/connections"
                     (lambda (params) (list-connections hub params)))
    (register-ide-method hub "ide/disconnect"
                         (lambda (ide params)
                           (declare (ignore params))
                           (disconnect ide)
                           nil))
    (register-ide-method hub "ide/eval" #'evaluate)
    (register-ide-method hub "ide/sylvesters" #'sylvesters)
    (register-ide-method hub "ide/repl/create" #'create-repl)
    (register-ide-method hub "ide/repl/send" #'send-to-repl)
    (register-ide-method hub "ide/repl/interrupt" #'interrupt-repl)
    (register-ide-method hub "ide/repl/close" #'close-repl)
    (register-ide-method hub "ide/repl/syncPackage" #'sync-repl-package)
    hub))
