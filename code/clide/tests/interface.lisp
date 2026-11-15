(defpackage :clide/tests/interface
  (:use :cl :5am)
  (:import-from :clide/tests/suite
                #:suite)
  (:export #:interface-suite)
  (:documentation "TODO"))

(in-package :clide/tests/interface)


;;; Code:

(def-suite interface-suite
  :description "Tests for interface module."
  :in suite)

(in-suite interface-suite)
