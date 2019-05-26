import { AnyConstructor, Mixin } from "../class/Mixin.js"
import { Box } from "./Box.js"


//---------------------------------------------------------------------------------------------------------------------
export type ChronoValue = any


//---------------------------------------------------------------------------------------------------------------------
export type ChronoIterator<ResultT = any, YieldT = any> = IterableIterator<YieldT | ResultT>


//---------------------------------------------------------------------------------------------------------------------
export type ChronoCalculationFunction<ResultT = any, YieldT = any, ArgsT extends any[] = any[]> = (...args : ArgsT) => ChronoIterator<ResultT, YieldT>


//---------------------------------------------------------------------------------------------------------------------
export const ChronoCalculation = <T extends AnyConstructor<Box>>(base : T) =>

class ChronoCalculation extends base {
    ArgsT               : any[]
    YieldT              : any

    calculationContext  : any

    iterator            : ChronoIterator<this[ 'ValueT' ], this[ 'YieldT' ]>

    iterationResult     : IteratorResult<any>


    isCalculationStarted () : boolean {
        return Boolean(this.iterator)
    }


    isCalculationCompleted () : boolean {
        return Boolean(this.iterationResult && this.iterationResult.done)
    }


    get value () : this[ 'ValueT' ] {
        return this.iterationResult && this.iterationResult.done ? this.iterationResult.value : undefined
    }


    startCalculation (...args : this[ 'ArgsT' ]) : IteratorResult<any> {
        const iterator : this[ 'iterator' ] = this.iterator = this.calculation.call(this.calculationContext || this, ...args)

        return this.iterationResult = iterator.next()
    }


    supplyYieldValue (value : this[ 'YieldT' ]) : IteratorResult<any> {
        return this.iterationResult = this.iterator.next(value)
    }


    * calculation (...args : this[ 'ArgsT' ]) : this[ 'iterator' ] {
        throw new Error("Abstract method `calculation` called")
    }


    runSyncWithEffect (onEffect : (effect : this[ 'YieldT' ]) => any, ...args : this[ 'ArgsT' ]) : this[ 'ValueT' ] {
        this.startCalculation(...args)

        while (!this.isCalculationCompleted()) {
            this.supplyYieldValue(onEffect(this.iterationResult.value))
        }

        return this.value
    }


    async runAsyncWithEffect (onEffect : (effect : this[ 'YieldT' ]) => Promise<any>, ...args : this[ 'ArgsT' ]) : Promise<this[ 'ValueT' ]> {
        this.startCalculation(...args)

        while (!this.isCalculationCompleted()) {
            this.supplyYieldValue(await onEffect(this.iterationResult.value))
        }

        return this.value
    }
}

export type ChronoCalculation = Mixin<typeof ChronoCalculation>