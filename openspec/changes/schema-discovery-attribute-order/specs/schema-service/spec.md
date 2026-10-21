## ADDED Requirements

### Requirement: Dynamic schema attribute-source order

`SchemaService.buildDynamicSchema` MUST collect candidate attributes from attribute definitions, then attribute mappings, then managed account source schemas, then identity schema attributes when identity scope is enabled (`config.includeIdentities !== false`). Because `dedupeSchemaAttributesByName` retains the first case-insensitive variant, an earlier source MUST win a name collision against a later source.

#### Scenario: Definition outranks a managed source attribute

- **GIVEN** an attribute definition named `department`
- **AND** a managed source account schema attribute named `Department`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the returned schema MUST contain exactly one attribute whose lowercase name is `department`
- **AND** that attribute MUST be the variant derived from the definition

#### Scenario: Definition outranks a mapping

- **GIVEN** an attribute definition named `employeeId`
- **AND** an attribute mapping whose new attribute name is `EmployeeId`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the returned schema MUST contain exactly one attribute whose lowercase name is `employeeid`
- **AND** that attribute MUST be the variant derived from the definition

#### Scenario: Mapping outranks a managed source attribute

- **GIVEN** an attribute mapping whose new attribute name is `costCenter`
- **AND** a managed source account schema attribute named `CostCenter`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the returned schema MUST contain exactly one attribute whose lowercase name is `costcenter`
- **AND** that attribute MUST be the variant derived from the mapping

#### Scenario: Managed source attribute outranks identity schema attribute

- **GIVEN** a managed source account schema attribute named `firstname`
- **AND** an identity schema attribute named `FirstName`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the returned schema MUST contain exactly one attribute whose lowercase name is `firstname`
- **AND** that attribute MUST be the managed source variant

#### Scenario: Identity schema attributes participate only when identity scope is enabled

- **GIVEN** identity scope is disabled (`config.includeIdentities === false`)
- **AND** an identity schema provides an attribute named `title`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the connector MUST NOT fetch identity schema attributes
- **AND** the returned schema MUST NOT contain an attribute derived from the identity schema

#### Scenario: Full source order still produces no duplicate lowercase names

- **GIVEN** fusion base attributes, definitions, mappings, managed source schemas, identity schema attributes, and reverse-correlation attributes with case-insensitive overlaps
- **WHEN** `SchemaService.buildDynamicSchema` returns
- **THEN** no two entries in `attributes` MAY share the same lowercase `name`

### Requirement: Fusion base and reverse-correlation attributes anchor the schema

`SchemaService.buildDynamicSchema` MUST collect fusion base structural attributes before all other sources and MUST collect reverse-correlation attributes after all other sources.

#### Scenario: Fusion base structural attributes are always present

- **GIVEN** a valid connector configuration
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** every attribute in `fusionAccountSchemaAttributes` MUST be present in the returned schema

#### Scenario: Reverse-correlation attributes have the lowest precedence

- **GIVEN** a source configured with `correlationMode: 'reverse'` and a `correlationAttribute` named `costCenter`
- **AND** a managed source account schema attribute named `CostCenter`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the returned schema MUST contain exactly one attribute whose lowercase name is `costcenter`
- **AND** that attribute MUST be the managed source variant
