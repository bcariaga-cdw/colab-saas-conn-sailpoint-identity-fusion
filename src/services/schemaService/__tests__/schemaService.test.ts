import { SchemaService } from '../schemaService'
import { fusionAccountSchemaAttributes } from '../../../data/schema'

describe('SchemaService', () => {
    let schemaService: SchemaService
    let mockConfig: any
    let mockLog: any
    let mockSources: any
    let mockIdentities: any

    beforeEach(() => {
        mockConfig = {
            attributeMerge: 'list',
            sources: [],
            includeIdentities: true,
        }
        mockLog = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }
        mockSources = {
            managedSources: [],
        }
        mockIdentities = {
            fetchIdentitySchemaAttributes: vi.fn().mockResolvedValue([
                { name: 'empId', description: 'Employee ID', type: 'string', multi: false, entitlement: false },
                { name: 'groups', description: 'Groups', type: 'string', multi: true, entitlement: false },
                {
                    name: 'unrecognized',
                    description: 'Unrecognized Type',
                    type: 'string',
                    multi: false,
                    entitlement: false,
                },
            ]),
        }

        schemaService = new SchemaService(mockConfig, mockLog, mockSources, mockIdentities)
    })

    describe('buildDynamicSchema', () => {
        it('should call identities.fetchIdentitySchemaAttributes and include mapped identity attributes correctly', async () => {
            const schema = await schemaService.buildDynamicSchema()

            expect(mockIdentities.fetchIdentitySchemaAttributes).toHaveBeenCalled()

            const empIdAttr = schema.attributes.find((a) => a.name === 'empId')
            expect(empIdAttr).toEqual({
                name: 'empId',
                description: 'Employee ID',
                type: 'string',
                multi: false,
                entitlement: false,
            })

            const unrecognizedAttr = schema.attributes.find((a) => a.name === 'unrecognized')
            expect(unrecognizedAttr).toBeDefined()
            expect(unrecognizedAttr?.type).toBe('string')
        })

        it('should preserve original casing on collisions', async () => {
            // Setup an account schema attribute with "EmployeeID"
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [{ name: 'EmployeeID', type: 'string', multi: false }],
            })

            // Setup identity attributes containing lowercase "employeeid" with different metadata
            mockIdentities.fetchIdentitySchemaAttributes.mockResolvedValue([
                {
                    name: 'employeeid',
                    description: 'employee id',
                    type: 'string',
                    multi: true,
                    entitlement: false,
                },
            ])

            const schema = await schemaService.buildDynamicSchema()

            const attr = schema.attributes.find((a) => a.name.toLowerCase() === 'employeeid')
            expect(attr?.name).toBe('EmployeeID')
            expect(attr?.description).toBe('EmployeeID from Source 1')
        })

        it('should dedupe Username and username from managed source', async () => {
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [
                    { name: 'Username', type: 'string', multi: false },
                    { name: 'username', type: 'string', multi: false },
                ],
            })

            const schema = await schemaService.buildDynamicSchema()
            const usernameAttrs = schema.attributes.filter((a) => a.name.toLowerCase() === 'username')

            expect(usernameAttrs).toHaveLength(1)
            expect(usernameAttrs[0].name).toBe('Username')
        })

        it('should dedupe FirstName from identity when firstname exists on managed source', async () => {
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [{ name: 'firstname', type: 'string', multi: false }],
            })
            mockIdentities.fetchIdentitySchemaAttributes.mockResolvedValue([
                { name: 'FirstName', type: 'string', multi: false, entitlement: false },
            ])

            const schema = await schemaService.buildDynamicSchema()
            const firstnameAttrs = schema.attributes.filter((a) => a.name.toLowerCase() === 'firstname')

            expect(firstnameAttrs).toHaveLength(1)
            expect(firstnameAttrs[0].name).toBe('firstname')
        })

        it('should dedupe LastName from identity when lastname exists on managed source', async () => {
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [{ name: 'lastname', type: 'string', multi: false }],
            })
            mockIdentities.fetchIdentitySchemaAttributes.mockResolvedValue([
                { name: 'LastName', type: 'string', multi: false, entitlement: false },
            ])

            const schema = await schemaService.buildDynamicSchema()
            const lastnameAttrs = schema.attributes.filter((a) => a.name.toLowerCase() === 'lastname')

            expect(lastnameAttrs).toHaveLength(1)
            expect(lastnameAttrs[0].name).toBe('lastname')
        })

        it('should handle API errors during fetch gracefully', async () => {
            mockIdentities.fetchIdentitySchemaAttributes.mockRejectedValue(new Error('Network Error'))

            const schema = await schemaService.buildDynamicSchema()

            expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch identity attributes'))
            // The schema builds successfully without the identity attributes
            expect(schema.attributes.length).toBeGreaterThan(0) // Has static/fusion attributes
        })

        const normalDefinition = (name: string, expression = `$${name}`) => ({
            name,
            expression,
            normalize: false,
            spaces: false,
            trim: false,
            refresh: false,
        })

        it('definition outranks a managed source attribute', async () => {
            mockConfig.normalAttributeDefinitions = [normalDefinition('department')]
            schemaService = new SchemaService(mockConfig, mockLog, mockSources, mockIdentities)
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [{ name: 'Department', type: 'string', multi: false }],
            })

            const schema = await schemaService.buildDynamicSchema()
            const matches = schema.attributes.filter((a) => a.name.toLowerCase() === 'department')

            expect(matches).toHaveLength(1)
            expect(matches[0].name).toBe('department')
            expect(matches[0].description).toBe('Created from expression: $department')
        })

        it('definition outranks a mapping', async () => {
            mockConfig.normalAttributeDefinitions = [normalDefinition('employeeId')]
            mockConfig.attributeMaps = [{ newAttribute: 'EmployeeId', existingAttributes: ['emp_id'] }]
            schemaService = new SchemaService(mockConfig, mockLog, mockSources, mockIdentities)

            const schema = await schemaService.buildDynamicSchema()
            const matches = schema.attributes.filter((a) => a.name.toLowerCase() === 'employeeid')

            expect(matches).toHaveLength(1)
            expect(matches[0].name).toBe('employeeId')
            expect(matches[0].description).toBe('Created from expression: $employeeId')
        })

        it('mapping outranks a managed source attribute', async () => {
            mockConfig.attributeMaps = [{ newAttribute: 'costCenter', existingAttributes: ['cc'] }]
            schemaService = new SchemaService(mockConfig, mockLog, mockSources, mockIdentities)
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [{ name: 'CostCenter', type: 'string', multi: false }],
            })

            const schema = await schemaService.buildDynamicSchema()
            const matches = schema.attributes.filter((a) => a.name.toLowerCase() === 'costcenter')

            expect(matches).toHaveLength(1)
            expect(matches[0].name).toBe('costCenter')
            expect(matches[0].description).toBe('Created from cc')
        })

        it('identity schema attributes participate only when identity scope is enabled', async () => {
            mockConfig.includeIdentities = false
            schemaService = new SchemaService(mockConfig, mockLog, mockSources, mockIdentities)

            const schema = await schemaService.buildDynamicSchema()

            expect(mockIdentities.fetchIdentitySchemaAttributes).not.toHaveBeenCalled()
            expect(schema.attributes.find((a) => a.name === 'empId')).toBeUndefined()
        })

        it('full source order produces no duplicate lowercase names and keeps fusion base attributes', async () => {
            mockConfig.normalAttributeDefinitions = [normalDefinition('shared')]
            mockConfig.attributeMaps = [{ newAttribute: 'SHARED', existingAttributes: ['shared_src'] }]
            schemaService = new SchemaService(mockConfig, mockLog, mockSources, mockIdentities)
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [{ name: 'Shared', type: 'string', multi: false }],
            })
            mockIdentities.fetchIdentitySchemaAttributes.mockResolvedValue([
                { name: 'shared', type: 'string', multi: false, entitlement: false },
            ])

            const schema = await schemaService.buildDynamicSchema()

            const lowerNames = schema.attributes.map((a) => a.name!.toLowerCase())
            expect(new Set(lowerNames).size).toBe(lowerNames.length)
            for (const base of fusionAccountSchemaAttributes) {
                expect(schema.attributes.some((a) => a.name === base.name)).toBe(true)
            }
            // The definition outranks the mapping, managed source, and identity variants.
            const shared = schema.attributes.filter((a) => a.name.toLowerCase() === 'shared')
            expect(shared).toHaveLength(1)
            expect(shared[0].name).toBe('shared')
        })

        it('reverse-correlation attributes have the lowest precedence', async () => {
            mockConfig.sources = [
                {
                    id: 'src-1',
                    name: 'Source 1',
                    correlationMode: 'reverse',
                    correlationAttribute: 'costCenter',
                },
            ]
            schemaService = new SchemaService(mockConfig, mockLog, mockSources, mockIdentities)
            mockSources.managedSources = [{ id: 'src-1', name: 'Source 1' }]
            vi.spyOn(schemaService as any, 'fetchAccountSchema').mockResolvedValue({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [{ name: 'CostCenter', type: 'string', multi: false }],
            })

            const schema = await schemaService.buildDynamicSchema()
            const matches = schema.attributes.filter((a) => a.name.toLowerCase() === 'costcenter')

            expect(matches).toHaveLength(1)
            expect(matches[0].name).toBe('CostCenter')
            expect(matches[0].description).toBe('CostCenter from Source 1')
        })
    })

    describe('getFusionAttributeSubset', () => {
        beforeEach(async () => {
            await schemaService.setFusionAccountSchema({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [
                    { name: 'id', type: 'string', required: true },
                    { name: 'name', type: 'string', required: true },
                    { name: 'department', type: 'string', multi: false },
                    { name: 'employeeId', type: 'string', multi: false, required: true },
                    { name: 'employeeNumber', type: 'int', multi: false },
                    { name: 'active', type: 'boolean', multi: false },
                    { name: 'reviews', type: 'string', multi: true },
                ],
            })
        })

        it('Unset attribute is omitted from subset', () => {
            const resultWithAbsent = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
            })

            expect(resultWithAbsent).not.toHaveProperty('department')
        })

        it('Populated attribute is retained', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
            })

            expect(result.name).toBe('Ada Wong')
        })

        it('Blank string is omitted', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                department: '',
            })

            expect(result).not.toHaveProperty('department')
        })

        it('Whitespace-only string is omitted', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                department: '   ',
            })

            expect(result).not.toHaveProperty('department')
        })

        it('Surrounding whitespace on a non-blank string is preserved', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                department: '  Finance  ',
            })

            expect(result.department).toBe('  Finance  ')
        })

        it('Empty multi-valued array is omitted', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                reviews: [],
            })

            expect(result).not.toHaveProperty('reviews')
        })

        it('Multi-valued array of only blank strings is omitted', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                reviews: ['', '  '],
            })

            expect(result).not.toHaveProperty('reviews')
        })

        it('Mixed multi-valued array drops blank elements', () => {
            const reviews = ['ok', '', '  ']
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                reviews,
            })

            expect(result.reviews).toEqual(['ok'])
            expect(reviews).toEqual(['ok', '', '  '])
        })

        it('Boolean false is retained', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                active: false,
            })

            expect(result.active).toBe(false)
        })

        it('Numeric zero is retained', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                employeeNumber: 0,
            })

            expect(result.employeeNumber).toBe(0)
        })

        it('Blank string on a numeric attribute is emitted as zero', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                employeeNumber: '',
            })

            expect(result.employeeNumber).toBe(0)
        })

        it('Blank string on a boolean attribute is emitted as false', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                active: '',
            })

            expect(result.active).toBe(false)
        })

        it('Blank identity attribute is retained', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '',
                name: 'Ada Wong',
            })

            expect(result.id).toBe('')
        })

        it('Whitespace-only display attribute is retained', () => {
            const result = schemaService.getFusionAttributeSubset({
                name: '   ',
            })

            expect(result.name).toBe('   ')
        })

        it('Present null identity attribute is emitted as null', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: null,
                name: 'Ada Wong',
            })

            expect(result).toHaveProperty('id', null)
        })

        it('Blank required attribute other than id or name is omitted', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                employeeId: '',
            })

            expect(result).not.toHaveProperty('employeeId')
        })

        it('String zero is retained', () => {
            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                department: '0',
            })

            expect(result.department).toBe('0')
        })

        it('Internal bag unchanged', () => {
            const reviews: string[] = []
            const input = {
                id: '1',
                name: 'Ada Wong',
                department: null,
                reviews,
            }

            const result = schemaService.getFusionAttributeSubset(input)

            expect(input).toEqual({
                id: '1',
                name: 'Ada Wong',
                department: null,
                reviews: [],
            })
            expect(input.reviews).toBe(reviews)
            expect(result).toHaveProperty('department', null)
            expect(result).not.toHaveProperty('reviews')
        })
    })

    describe('setFusionAccountSchema', () => {
        it('dedupes case-insensitive duplicate attribute names from input schema', async () => {
            await schemaService.setFusionAccountSchema({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [
                    { name: 'LastName', type: 'string', multi: false },
                    { name: 'lastname', type: 'string', multi: false },
                ],
            })

            const names = schemaService.listSchemaAttributeNames()
            const lastnameNames = names.filter((n) => n.toLowerCase() === 'lastname')
            expect(lastnameNames).toHaveLength(1)
            expect(lastnameNames[0]).toBe('LastName')
        })

        it('emits a single key from getFusionAttributeSubset when bag has duplicate casings', async () => {
            await schemaService.setFusionAccountSchema({
                displayAttribute: 'name',
                identityAttribute: 'id',
                attributes: [
                    { name: 'LastName', type: 'string', multi: false },
                    { name: 'lastname', type: 'string', multi: false },
                ],
            })

            const result = schemaService.getFusionAttributeSubset({
                id: '1',
                name: 'Ada Wong',
                LastName: 'Wong',
                lastname: 'Ignored',
            })

            expect(Object.keys(result).filter((k) => k.toLowerCase() === 'lastname')).toHaveLength(1)
            expect(result.LastName).toBe('Wong')
            expect(result).not.toHaveProperty('lastname')
        })
    })
})
