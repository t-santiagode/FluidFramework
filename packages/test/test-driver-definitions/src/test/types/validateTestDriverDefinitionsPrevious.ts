/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
/*
 * THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
 * Generated by fluid-type-validator in @fluidframework/build-tools.
 */
import * as old from "@fluidframework/test-driver-definitions-previous";
import * as current from "../../index";

type TypeOnly<T> = {
    [P in keyof T]: TypeOnly<T[P]>;
};

/*
* Validate forward compat by using old type in place of current type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_DriverEndpoint": {"forwardCompat": false}
*/
declare function get_old_TypeAliasDeclaration_DriverEndpoint():
    TypeOnly<old.DriverEndpoint>;
declare function use_current_TypeAliasDeclaration_DriverEndpoint(
    use: TypeOnly<current.DriverEndpoint>);
use_current_TypeAliasDeclaration_DriverEndpoint(
    get_old_TypeAliasDeclaration_DriverEndpoint());

/*
* Validate back compat by using current type in place of old type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_DriverEndpoint": {"backCompat": false}
*/
declare function get_current_TypeAliasDeclaration_DriverEndpoint():
    TypeOnly<current.DriverEndpoint>;
declare function use_old_TypeAliasDeclaration_DriverEndpoint(
    use: TypeOnly<old.DriverEndpoint>);
use_old_TypeAliasDeclaration_DriverEndpoint(
    get_current_TypeAliasDeclaration_DriverEndpoint());

/*
* Validate forward compat by using old type in place of current type
* If breaking change required, add in package.json under typeValidation.broken:
* "InterfaceDeclaration_ITelemetryBufferedLogger": {"forwardCompat": false}
*/
declare function get_old_InterfaceDeclaration_ITelemetryBufferedLogger():
    TypeOnly<old.ITelemetryBufferedLogger>;
declare function use_current_InterfaceDeclaration_ITelemetryBufferedLogger(
    use: TypeOnly<current.ITelemetryBufferedLogger>);
use_current_InterfaceDeclaration_ITelemetryBufferedLogger(
    get_old_InterfaceDeclaration_ITelemetryBufferedLogger());

/*
* Validate back compat by using current type in place of old type
* If breaking change required, add in package.json under typeValidation.broken:
* "InterfaceDeclaration_ITelemetryBufferedLogger": {"backCompat": false}
*/
declare function get_current_InterfaceDeclaration_ITelemetryBufferedLogger():
    TypeOnly<current.ITelemetryBufferedLogger>;
declare function use_old_InterfaceDeclaration_ITelemetryBufferedLogger(
    use: TypeOnly<old.ITelemetryBufferedLogger>);
use_old_InterfaceDeclaration_ITelemetryBufferedLogger(
    get_current_InterfaceDeclaration_ITelemetryBufferedLogger());

/*
* Validate forward compat by using old type in place of current type
* If breaking change required, add in package.json under typeValidation.broken:
* "InterfaceDeclaration_ITestDriver": {"forwardCompat": false}
*/
declare function get_old_InterfaceDeclaration_ITestDriver():
    TypeOnly<old.ITestDriver>;
declare function use_current_InterfaceDeclaration_ITestDriver(
    use: TypeOnly<current.ITestDriver>);
use_current_InterfaceDeclaration_ITestDriver(
    get_old_InterfaceDeclaration_ITestDriver());

/*
* Validate back compat by using current type in place of old type
* If breaking change required, add in package.json under typeValidation.broken:
* "InterfaceDeclaration_ITestDriver": {"backCompat": false}
*/
declare function get_current_InterfaceDeclaration_ITestDriver():
    TypeOnly<current.ITestDriver>;
declare function use_old_InterfaceDeclaration_ITestDriver(
    use: TypeOnly<old.ITestDriver>);
use_old_InterfaceDeclaration_ITestDriver(
    get_current_InterfaceDeclaration_ITestDriver());

/*
* Validate forward compat by using old type in place of current type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_OdspEndpoint": {"forwardCompat": false}
*/
declare function get_old_TypeAliasDeclaration_OdspEndpoint():
    TypeOnly<old.OdspEndpoint>;
declare function use_current_TypeAliasDeclaration_OdspEndpoint(
    use: TypeOnly<current.OdspEndpoint>);
use_current_TypeAliasDeclaration_OdspEndpoint(
    get_old_TypeAliasDeclaration_OdspEndpoint());

/*
* Validate back compat by using current type in place of old type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_OdspEndpoint": {"backCompat": false}
*/
declare function get_current_TypeAliasDeclaration_OdspEndpoint():
    TypeOnly<current.OdspEndpoint>;
declare function use_old_TypeAliasDeclaration_OdspEndpoint(
    use: TypeOnly<old.OdspEndpoint>);
use_old_TypeAliasDeclaration_OdspEndpoint(
    get_current_TypeAliasDeclaration_OdspEndpoint());

/*
* Validate forward compat by using old type in place of current type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_RouterliciousEndpoint": {"forwardCompat": false}
*/
declare function get_old_TypeAliasDeclaration_RouterliciousEndpoint():
    TypeOnly<old.RouterliciousEndpoint>;
declare function use_current_TypeAliasDeclaration_RouterliciousEndpoint(
    use: TypeOnly<current.RouterliciousEndpoint>);
use_current_TypeAliasDeclaration_RouterliciousEndpoint(
    get_old_TypeAliasDeclaration_RouterliciousEndpoint());

/*
* Validate back compat by using current type in place of old type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_RouterliciousEndpoint": {"backCompat": false}
*/
declare function get_current_TypeAliasDeclaration_RouterliciousEndpoint():
    TypeOnly<current.RouterliciousEndpoint>;
declare function use_old_TypeAliasDeclaration_RouterliciousEndpoint(
    use: TypeOnly<old.RouterliciousEndpoint>);
use_old_TypeAliasDeclaration_RouterliciousEndpoint(
    get_current_TypeAliasDeclaration_RouterliciousEndpoint());

/*
* Validate forward compat by using old type in place of current type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_TestDriverTypes": {"forwardCompat": false}
*/
declare function get_old_TypeAliasDeclaration_TestDriverTypes():
    TypeOnly<old.TestDriverTypes>;
declare function use_current_TypeAliasDeclaration_TestDriverTypes(
    use: TypeOnly<current.TestDriverTypes>);
use_current_TypeAliasDeclaration_TestDriverTypes(
    get_old_TypeAliasDeclaration_TestDriverTypes());

/*
* Validate back compat by using current type in place of old type
* If breaking change required, add in package.json under typeValidation.broken:
* "TypeAliasDeclaration_TestDriverTypes": {"backCompat": false}
*/
declare function get_current_TypeAliasDeclaration_TestDriverTypes():
    TypeOnly<current.TestDriverTypes>;
declare function use_old_TypeAliasDeclaration_TestDriverTypes(
    use: TypeOnly<old.TestDriverTypes>);
use_old_TypeAliasDeclaration_TestDriverTypes(
    get_current_TypeAliasDeclaration_TestDriverTypes());