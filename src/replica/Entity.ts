import { ChronoGraph } from "../chrono/Graph.js"
import { Identifier } from "../chrono/Identifier.js"
import { Effect, SyncEffectHandler, YieldableValue } from "../chrono/Transaction.js"
import { instanceOf } from "../class/InstanceOf.js"
import { AnyConstructor, AnyFunction, Mixin } from "../class/Mixin.js"
import { CalculationIterator, runGeneratorSyncWithEffect } from "../primitives/Calculation.js"
import { EntityMeta } from "../schema/EntityMeta.js"
import { Field, Name } from "../schema/Field.js"
import { defineProperty, uppercaseFirst } from "../util/Helpers.js"
import { EntityIdentifierI, FieldIdentifier, FieldIdentifierI, MinimalEntityIdentifier } from "./Identifier.js"
import { Replica, ReplicaI } from "./Replica.js"


const isEntityMarker      = Symbol('isEntity')

//---------------------------------------------------------------------------------------------------------------------
export const Entity = instanceOf(<T extends AnyConstructor<object>>(base : T) => {

    class Entity extends base {
        // marker in the prototype to identify whether the parent class is Entity mixin itself
        [isEntityMarker] () {}

        $calculations   : { [s in keyof this] : string }

        graph           : ChronoGraph

        // lazy meta instance creation - will work even w/o any @field or @entity decorator
        get $entity () : EntityMeta {
            // this will lazily create an EntityData instance in the prototype
            return createEntityOnPrototype(this.constructor.prototype)
        }


        get $ () : { [s in keyof this] : FieldIdentifierI } {
            // TODO
            // // the individual identifiers are populated lazily
            // return defineProperty(this as any, '$', new this.$entity.skeletonClass(this))

            const $ = {}

            this.$entity.forEachField((field, name) => {
                $[ name ]   = this.createFieldIdentifier(field)
            })

            return defineProperty(this as any, '$', $)
        }


        get $$ () : EntityIdentifierI {
            return defineProperty(this, '$$', MinimalEntityIdentifier.new({
                name                : this.$entity.name,
                entity              : this.$entity,

                self                : this,

                // entity atom is considered changed if any of its incoming atoms has changed
                // this just means if it's calculation method has been called, it should always
                // assign a new value
                equality            : () => false,

                calculation         : this.calculateSelf,
                context             : this
            }))
        }


        * calculateSelf () : CalculationIterator<this> {
            return this
        }


        createFieldIdentifier (field : Field) : FieldIdentifierI {
            const name                  = field.name

            const calculationFunction   = this.$calculations && this[ this.$calculations[ name ] ]

            let config

            if (calculationFunction) {
                config                  = {
                    name                : `${this.$$.name}/${name}`,

                    field               : field,

                    self                : this,

                    calculation         : calculationFunction,
                    context             : this
                }
            } else {
                config                  = {
                    name                : `${this.$$.name}/${name}`,

                    field               : field,

                    self                : this
                }
            }

            return field.identifierCls.new(config)
        }


        // forEachFieldAtom<T extends this> (func : (field : MinimalFieldAtom, name : keyof T) => any) {
        //     const fields        = this.$
        //
        //     for (let name in fields) {
        //         func.call(this, fields[ name ], name)
        //     }
        // }


        enterGraph (replica : ChronoGraph) {
            if (this.graph) throw new Error('Already entered replica')

            this.graph        = replica

            replica.addIdentifier(this.$$)

            const keys  = Object.keys(this.$)

            // only the already created identifiers will be added
            for (let i = 0; i < keys.length; i++) {
                const identifier    = this.$[ keys[ i ] ]

                replica.addIdentifier(identifier)

                if (identifier.DATA !== undefined) {
                    replica.write(identifier, identifier.DATA)
                    identifier.DATA = undefined
                }
            }
        }


        leaveGraph () {
            const graph     = this.graph
            if (!graph) return
            this.graph      = undefined

            const keys  = Object.keys(this.$)

            // only the already created identifiers will be added
            for (let i = 0; i < keys.length; i++) {
                graph.removeIdentifier(this.$[ keys[ i ] ])
            }

            graph.removeIdentifier(this.$$)
        }

        // isPropagating () {
        //     return this.getGraph().isPropagating
        // }

        async propagate () {
            const graph     = this.graph

            if (!graph) return

            return graph.propagate()
        }


        // async waitForPropagateCompleted () : Promise<PropagationResult | null> {
        //     return this.getGraph().waitForPropagateCompleted()
        // }
        //
        //
        // async tryPropagateWithNodes (onEffect? : EffectResolverFunction, nodes? : ChronoAtom[], hatchFn? : Function) : Promise<PropagationResult> {
        //     return this.getGraph().tryPropagateWithNodes(onEffect, nodes, hatchFn)
        // }
        //
        //
        // async tryPropagateWithEntities (onEffect? : EffectResolverFunction, entities? : Entity[], hatchFn? : Function) : Promise<PropagationResult> {
        //     const graph = this.getGraph()
        //
        //     let result
        //
        //     if (isReplica(graph)) {
        //         result = graph.tryPropagateWithEntities(onEffect, entities, hatchFn)
        //     }
        //     else {
        //         throw new Error("Entity is not part of replica")
        //     }
        //
        //     return result
        // }
        //
        //
        // markAsNeedRecalculation (atom : ChronoAtom) {
        //     this.getGraph().markAsNeedRecalculation(atom)
        // }


        static getField (name : Name) : Field {
            return this.getEntity().getField(name)
        }


        static getEntity () : EntityMeta {
            return ensureEntityOnPrototype(this.prototype)
        }


        run <Name extends keyof this, S extends AnyFunction & this[ Name ]> (methodName : Name, ...args : Parameters<S>)
            : ReturnType<S> extends CalculationIterator<infer Res1> ? Res1 : ReturnType<S>
        {
            const onEffect : SyncEffectHandler = (effect : YieldableValue) => {
                if (effect instanceof Identifier) return this.graph.read(effect)

                throw new Error("Helper methods can not yield effects during computation")
            }

            return runGeneratorSyncWithEffect(this[ methodName ] as S, [ onEffect, ...args ], this)
        }
    }

    return Entity
})

export type Entity = Mixin<typeof Entity>


//---------------------------------------------------------------------------------------------------------------------
export const createEntityOnPrototype = (proto : any) : EntityMeta => {
    let parent      = Object.getPrototypeOf(proto)

    // the `hasOwnProperty` condition will be `true` for the `Entity` mixin itself
    // if the parent is `Entity` mixin, then this is a top-level entity
    return defineProperty(proto, '$entity', EntityMeta.new({ parentEntity : parent.hasOwnProperty(isEntityMarker) ? null : parent.$entity }))
}


//---------------------------------------------------------------------------------------------------------------------
export const ensureEntityOnPrototype = (proto : any) : EntityMeta => {
    let entity      = proto.$entity

    if (!proto.hasOwnProperty('$entity')) entity = createEntityOnPrototype(proto)

    return entity
}


export type FieldDecorator<Default extends AnyConstructor = typeof Field> =
    <T extends Default = Default> (fieldConfig? : Partial<InstanceType<T>>, fieldCls? : T | Default) => PropertyDecorator


/**
 * The "generic" field decorator, in the sense, that it allows specifying both field config and field class.
 * This means it can create any field instance.
 */
export const generic_field : FieldDecorator<typeof Field> =
    <T extends typeof Field = typeof Field> (fieldConfig? : Partial<InstanceType<T>>, fieldCls : T | typeof Field = Field) : PropertyDecorator => {

        return function (target : Entity, propertyKey : string) : void {
            const entity    = ensureEntityOnPrototype(target)

            const field     = entity.addField(
                fieldCls.new(Object.assign(fieldConfig || {}, {
                    name    : propertyKey
                }))
            )

            Object.defineProperty(target, propertyKey, {
                get     : function () {
                    if (this.graph) {
                        return this.graph.read(this.$[ propertyKey ])
                    } else {
                        return this.$[ propertyKey ].DATA
                    }
                },

                set     : function (value : any) {
                    if (this.graph) {
                        return this.graph.write(this.$[ propertyKey ], value)
                    } else {
                        this.$[ propertyKey ].DATA = value
                    }
                }
            })

            // const getterFnName = `get${ uppercaseFirst(propertyKey) }`
            // const setterFnName = `set${ uppercaseFirst(propertyKey) }`
            //
            // if (!(getterFnName in target)) {
            //     target[ getterFnName ] = function (...args) : unknown {
            //         return this.$[ propertyKey ].get(...args)
            //     }
            // }
            //
            // if (!(setterFnName in target)) {
            //     target[ setterFnName ] = function (...args) : unknown {
            //         return this.$[ propertyKey ].set(...args)
            //     }
            // }
        }
    }


//---------------------------------------------------------------------------------------------------------------------
export const field : typeof generic_field = generic_field


//---------------------------------------------------------------------------------------------------------------------
export const calculate = function (fieldName : Name) : MethodDecorator {

    // `target` will be a prototype of the class with Entity mixin
    return function (target : Entity, propertyKey : string, _descriptor : TypedPropertyDescriptor<any>) : void {
        let calculations        = target.$calculations

        if (!calculations) calculations = target.$calculations = <any> {}

        calculations[ fieldName ]       = propertyKey
    }
}
