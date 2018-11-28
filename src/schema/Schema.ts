import {Base, Constructable, Mixin} from "../util/Mixin.js";


export type Name    = string | Symbol
export type Type    = string


//-----------------------------------------------------------------------------
export class Field extends Base {
    name                : Name
    type                : Type
}


//-----------------------------------------------------------------------------
export class Entity extends Base {
    name                : Name

    fields              : Map<Name, Field>      = new Map()


    field (name : Name) : Field {
        return this.fields.get(name)
    }
}


//-----------------------------------------------------------------------------
export class Schema extends Base {
    name                : Name

    entities            : Map<Name, Entity>     = new Map()


    entity (name : Name) : Entity {
        return this.entities.get(name)
    }


    entityDecorator (name : Name) {
        return () => {

        }
    }
}



export const atom          = (...args) : any => {}
export const field         = (...args) : any => {}
export const entity        = (...args) : any => {}
export const as            = (...args) : any => {}
export const lifecycle     = (...args) : any => {}
export const before        = (...args) : any => {}
export const after          = (...args) : any => {}
export const superOf        = (...args) : any => {}
export const context       = (...args) : any => {}
export const inputs        = (...args) : any => {}
export const mutation       = (...args) : any => {}


// export function inputs(value: { [s : string] : ChronoAtomReference }) {
//
//     return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
//     };
// }
//
//
//
// function inputs2(value: { [s : string] : ChronoAtomReference }) {
//
//     return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
//     };
// }
