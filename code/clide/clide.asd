(defsystem "clide"
  :description "Lisp side of VSCLIDE: slynk bridge and JSON-RPC server."
  :author "Erik P Almaraz"
  :license "MIT"
  :version (:read-file-form "version.sexp" :at (0 1))
  :depends-on ("bordeaux-threads"
               "cl-ppcre"
               "trivial-gray-streams"
               "flexi-streams"
               "usocket"
               "com.inuoe.jzon")
  :components ((:module "lib"
                :pathname "lib"
                :components ((:file "ansi-color")
                             (:file "jsonrpc")
                             (:file "slynk-wire")))
               (:module "base"
                :pathname "base"
                :depends-on ("lib")
                :components ((:file "server")
                             (:file "slynk-client")
                             (:file "ide" :depends-on ("server" "slynk-client"))
                             (:file "location" :depends-on ("ide"))
                             (:file "debugger" :depends-on ("ide" "location"))
                             (:file "inspector" :depends-on ("ide"))
                             (:file "language" :depends-on ("ide" "location"))
                             (:file "compiler" :depends-on ("ide" "location"))))
               (:module "interface"
                :pathname "./"
                :depends-on ("lib" "base")
                :components ((:file "clide"))))
  :in-order-to ((test-op (test-op "clide/tests")))
  :build-operation "program-op"
  :build-pathname "../../out/clide"
  :entry-point "clide:main"
  :long-description "
clide is the Common Lisp side of VSCLIDE, a Common Lisp IDE for VS Code.
It speaks slynk to a running Lisp and serves the extension over JSON-RPC
on a loopback socket.")


;;; Subsystems

(defsystem "clide/tests"
  :description "Unit Tests."
  :depends-on ("clide" "fiveam" "slynk")
  :components
  ((:module "tests"
    :components
    ((:file "suite")
     (:file "lib" :depends-on ("suite"))
     (:file "base" :depends-on ("suite"))
     (:file "slynk" :depends-on ("suite"))
     (:file "interface" :depends-on ("suite")))))
  :perform (test-op (o c) (symbol-call :fiveam :run!
                                       (find-symbol "SUITE"
                                                    :clide/tests/suite))))
