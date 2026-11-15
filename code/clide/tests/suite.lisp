(defpackage :clide/tests/suite
  (:use :cl :5am)
  (:export #:suite)
  (:documentation "Root suite for all unit tests."))

(in-package :clide/tests/suite)


;;; Code:

(def-suite suite
  :description "All unit tests.")
