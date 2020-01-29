import { Base } from "../class/BetterMixin.js"
import { DEBUG } from "../environment/Debug.js"
import { cycleInfo, OnCycleAction, WalkStep } from "../graph/WalkDepth.js"
import { CalculationContext, runGeneratorAsyncWithEffect, SynchronousCalculationStarted } from "../primitives/Calculation.js"
import { delay } from "../util/Helpers.js"
import { LeveledQueue } from "../util/LeveledQueue.js"
import { Checkout, CommitArguments } from "./Checkout.js"
import {
    Effect,
    HasProposedValueSymbol,
    OwnIdentifierSymbol,
    OwnQuarkSymbol,
    PreviousValueOfEffect,
    PreviousValueOfSymbol,
    ProposedArgumentsOfSymbol,
    ProposedOrCurrentSymbol,
    ProposedOrPreviousValueOfSymbol,
    ProposedValueOfEffect,
    ProposedValueOfSymbol,
    TransactionSymbol,
    UnsafeProposedOrPreviousValueOfSymbol,
    WriteEffect,
    WriteSeveralEffect,
    WriteSeveralSymbol,
    WriteSymbol
} from "./Effect.js"
import { Identifier, Levels, throwUnknownIdentifier } from "./Identifier.js"
import { EdgeType, Quark, TombStone } from "./Quark.js"
import { Revision, Scope } from "./Revision.js"
import { ComputationCycle, TransactionCycleDetectionWalkContext } from "./TransactionCycleDetectionWalkContext.js"
import { TransactionWalkDepth } from "./TransactionWalkDepth.js"


//---------------------------------------------------------------------------------------------------------------------
export type NotPromise<T> = T extends Promise<any> ? never : T

export type YieldableValue = Effect | Identifier | Promise<any>

export type SyncEffectHandler = <T extends any>(effect : YieldableValue) => T & NotPromise<T>
export type AsyncEffectHandler = <T extends any>(effect : YieldableValue) => Promise<T>


//---------------------------------------------------------------------------------------------------------------------
// weird stack overflow on 1300 deep benchmark, when using `EdgeType.Normal` w/o aliasing it to constant first

export const EdgeTypeNormal    = EdgeType.Normal
export const EdgeTypePast      = EdgeType.Past

const BreakCurrentStackExecution    = Symbol('BreakCurrentStackExecution')


//---------------------------------------------------------------------------------------------------------------------
export type TransactionCommitResult = { revision : Revision, entries : Scope }


//---------------------------------------------------------------------------------------------------------------------
export class Transaction extends Base {
    baseRevision            : Revision              = undefined

    candidate               : Revision              = undefined

    graph                   : Checkout              = undefined

    isClosed                : boolean               = false

    walkContext             : TransactionWalkDepth   = undefined

    // // we use 2 different stacks, because they support various effects
    // stackSync               : LeveledQueue<Quark>  = new LeveledQueue()
    // the `stackGen` supports async effects notably
    stackGen                : LeveledQueue<Quark>  = new LeveledQueue()

    // is used for tracking the active quark entry (quark entry being computed)
    activeStack             : Quark[]               = []

    onEffectSync            : SyncEffectHandler     = undefined
    onEffectAsync           : AsyncEffectHandler    = undefined

    //---------------------
    propagationStartDate            : number        = 0
    lastProgressNotificationDate    : number        = 0

    startProgressNotificationsAfterMs : number      = 500
    emitProgressNotificationsEveryMs  : number      = 200

    // TODO auto-adjust this parameter to match the emitProgressNotificationsEveryMs (to avoid calls to time functions)
    emitProgressNotificationsEveryCalculations  : number = 100

    plannedTotalIdentifiersToCalculate  : number    = 0

    // writes                  : WriteInfo[]           = []

    ongoing                 : Promise<any>          = Promise.resolve()

    selfDependedMarked      : boolean               = false


    initialize (...args) {
        super.initialize(...args)

        this.walkContext    = TransactionWalkDepth.new({
            baseRevision    : this.baseRevision,
            pushTo          : this.stackGen
        })

        if (!this.candidate) this.candidate = Revision.new({ previous : this.baseRevision })

        // the `onEffectSync` should be bound to the `yieldSync` of course, and `yieldSync` should look like:
        //     yieldSync (effect : YieldableValue) : any {
        //         if (effect instanceof Identifier) return this.read(effect)
        //     }
        // however, the latter consumes more stack frames - every read goes through `yieldSync`
        // since `read` is the most used effect anyway, we bind `onEffectSync` to `read` and
        // instead inside of `read` delegate to `yieldSync` for non-identifiers
        this.onEffectSync   = /*this.onEffectAsync =*/ this.read.bind(this)
        this.onEffectAsync  = this.readAsync.bind(this)
    }


    markSelfDependent () {
        if (this.selfDependedMarked) return

        this.selfDependedMarked = true

        for (const selfDependentQuark of this.baseRevision.selfDependent) this.touch(selfDependentQuark)
    }


    get entries () : Map<Identifier, Quark> {
        return this.walkContext.visited
    }


    isEmpty () : boolean {
        return this.entries.size === 0
    }


    // onNewWrite () {
    //     this.writes.forEach(writeInfo => {
    //         const identifier    = writeInfo.identifier
    //
    //         identifier.write.call(identifier.context || identifier, identifier, this, null, ...writeInfo.proposedArgs)
    //     })
    //
    //     this.writes.length = 0
    // }


    getActiveEntry () : Quark {
        return this.activeStack[ this.activeStack.length - 1 ]

        // // `stackSync` is always empty, except when the synchronous "batch" is being processed
        // const activeStack   = this.stackSync.length > 0 ? this.stackSync : this.stackGen
        //
        // return activeStack.last()
    }


    async yieldAsync (effect : Effect) : Promise<any> {
        if (effect instanceof Promise) return effect
            // throw new Error("Effect resolved to promise in the synchronous context, check that you marked the asynchronous calculations accordingly")

        return this[ effect.handler ](effect, this.getActiveEntry())
    }


    // see the comment for the `onEffectSync`
    yieldSync (effect : Effect) : any {
        return this[ effect.handler ](effect, this.getActiveEntry())
    }


    // readOptmistically <T> (identifier : Identifier<T>) : T {
    //     // see the comment for the `onEffectSync`
    //     if (!(identifier instanceof Identifier)) return this.yieldSync(identifier as Effect)
    //
    //     //----------------------
    //     const entry         = this.addEdge(identifier, this.getActiveEntry(), EdgeTypeNormal)
    //
    //     if (entry.hasValue()) return entry.getValue()
    //
    //     //----------------------
    //     this.stackSync.push(entry)
    //
    //     this.calculateTransitionsStackSync(this.onEffectSync, this.stackSync)
    //
    //     if (!entry.hasValue()) throw new Error('Cycle during synchronous computation')
    //
    //     return entry.getValue()
    // }


    // this seems to be an optimistic version
    async readAsync<T> (identifier : Identifier<T>) : Promise<T> {
        // see the comment for the `onEffectSync`
        if (!(identifier instanceof Identifier)) return this.yieldAsync(identifier as Effect)

        //----------------------
        while (this.stackGen.lowestLevel < identifier.level) {
            await runGeneratorAsyncWithEffect(this.onEffectAsync, this.calculateTransitionsStackGen, [ this.onEffectAsync, this.stackGen.takeLowestLevel() ], this)
        }


        let entry : Quark

        const activeEntry   = this.getActiveEntry()

        if (activeEntry) {
            entry           = this.addEdge(identifier, activeEntry, EdgeTypeNormal)
        } else {
            entry           = this.entries.get(identifier)

            if (!entry) return this.baseRevision.readAsync(identifier)
        }

        if (entry.hasValue()) return entry.getValue()
        if (entry.promise) return entry.promise

        //----------------------
        // TODO should use `onReadIdentifier` somehow? to have the same control flow for reading sync/gen identifiers?
        // now need to repeat the logic
        if (!entry.previous || !entry.previous.hasValue()) entry.forceCalculation()

        this.markSelfDependent()

        return this.ongoing = entry.promise = this.ongoing.then(() => {
            return runGeneratorAsyncWithEffect(this.onEffectAsync, this.calculateTransitionsStackGen, [ this.onEffectAsync, [ entry ] ], this)
        }).then(() => {
            // TODO review this exception
            if (!entry.hasValue()) throw new Error('Computation cycle. Sync')

            return entry.getValue()
        })
    }


    get<T> (identifier : Identifier<T>) : T | Promise<T> {
        // see the comment for the `onEffectSync`
        if (!(identifier instanceof Identifier)) return this.yieldSync(identifier as Effect)

        //----------------------
        while (this.stackGen.getLowestLevel() < identifier.level) {
            // here we force the computations for lower level identifiers should be sync
            this.calculateTransitionsStackSync(this.onEffectSync, this.stackGen.takeLowestLevel())
        }

        let entry : Quark

        const activeEntry   = this.getActiveEntry()

        if (activeEntry) {
            entry           = this.addEdge(identifier, activeEntry, EdgeTypeNormal)
        } else {
            entry           = this.entries.get(identifier)

            if (!entry) return this.baseRevision.get(identifier)
        }

        const value1        = entry.getValue()

        if (value1 === TombStone) throwUnknownIdentifier(identifier)

        if (value1 !== undefined) return value1
        if (entry.promise) return entry.promise

        //----------------------
        // TODO should use `onReadIdentifier` somehow? to have the same control flow for reading sync/gen identifiers?
        // now need to repeat the logic
        if (!entry.previous || !entry.previous.hasValue()) entry.forceCalculation()

        this.markSelfDependent()

        if (identifier.sync) {
            this.calculateTransitionsStackSync(this.onEffectSync, [ entry ])

            const value     = entry.getValue()

            // TODO review this exception
            if (value === undefined) throw new Error('Cycle during synchronous computation')
            if (value === TombStone) throwUnknownIdentifier(identifier)

            return value
        } else {
            const promise = this.ongoing = entry.promise = this.ongoing.then(() => {
                return runGeneratorAsyncWithEffect(this.onEffectAsync, this.calculateTransitionsStackGen, [ this.onEffectAsync, [ entry ] ], this)
            }).then(() => {
                const value     = entry.getValue()

                // TODO review this exception
                if (value === undefined) throw new Error('Computation cycle. Async get')
                if (value === TombStone) throwUnknownIdentifier(identifier)

                return value
                // // TODO review this exception
                // if (!entry.hasValue()) throw new Error('Computation cycle. Async get')
                //
                // return entry.getValue()
            })

            if (DEBUG) {
                // @ts-ignore
                promise.quark = entry
            }

            return promise



            // return runGeneratorAsyncWithEffect(this.onEffectAsync, this.calculateTransitionsStackGen, [ this.onEffectAsync, [ entry ] ], this).then(() => {
            //     const value     = entry.getValue()
            //
            //     // TODO review this exception
            //     if (value === undefined) throw new Error('Cycle during synchronous computation')
            //     if (value === TombStone) throwUnknownIdentifier(identifier)
            //
            //     return value
            // })
        }
    }


    // this seems to be an optimistic version
    read<T> (identifier : Identifier<T>) : T {
        // see the comment for the `onEffectSync`
        if (!(identifier instanceof Identifier)) return this.yieldSync(identifier as Effect)

        //----------------------
        while (this.stackGen.getLowestLevel() < identifier.level) {
            this.calculateTransitionsStackSync(this.onEffectSync, this.stackGen.takeLowestLevel())
        }

        let entry : Quark

        const activeEntry   = this.getActiveEntry()

        if (activeEntry) {
            entry           = this.addEdge(identifier, activeEntry, EdgeTypeNormal)
        } else {
            entry           = this.entries.get(identifier)

            if (!entry) return this.baseRevision.read(identifier)
        }

        const value1        = entry.getValue()

        if (value1 === TombStone) throwUnknownIdentifier(identifier)
        if (value1 !== undefined) return value1

        if (!identifier.sync) throw new Error("Can not calculate asynchronous identifier synchronously")

        // TODO should use `onReadIdentifier` somehow? to have the same control flow for reading sync/gen identifiers?
        // now need to repeat the logic
        if (!entry.previous || !entry.previous.hasValue()) entry.forceCalculation()

        //----------------------
        this.markSelfDependent()

        this.calculateTransitionsStackSync(this.onEffectSync, [ entry ])

        const value     = entry.getValue()

        // TODO review this exception
        if (value === undefined) throw new Error('Cycle during synchronous computation')
        if (value === TombStone) throwUnknownIdentifier(identifier)

        return value
    }


    readProposedOrPrevious<T> (identifier : Identifier<T>) : T {
        const dirtyQuark    = this.entries.get(identifier)

        if (dirtyQuark && dirtyQuark.proposedValue !== undefined) {
            return dirtyQuark.proposedValue
        } else
            return this.baseRevision.readIfExists(identifier)
    }


    readProposedOrPreviousAsync<T> (identifier : Identifier<T>) : Promise<T> {
        const dirtyQuark    = this.entries.get(identifier)

        if (dirtyQuark && dirtyQuark.proposedValue !== undefined) {
            return dirtyQuark.proposedValue
        } else
            return this.baseRevision.readIfExistsAsync(identifier)
    }


    write (identifier : Identifier, proposedValue : any, ...args : any[]) {
        if (proposedValue === undefined) proposedValue = null

        // this.writes.push(WriteEffect.new({
        //     identifier      : identifier,
        //     proposedArgs    : [ proposedValue, ...args ]
        // }))
        //
        // this.onNewWrite()

        identifier.write.call(identifier.context || identifier, identifier, this, null, /*this.getWriteTarget(identifier),*/ proposedValue, ...args)
    }


    // acquireQuark<T extends Identifier> (identifier : T) : InstanceType<T[ 'quarkClass' ]> {
    //     return this.touch(identifier).startOrigin() as InstanceType<T[ 'quarkClass' ]>
    // }


    getWriteTarget<T extends Identifier> (identifier : T) : InstanceType<T[ 'quarkClass' ]> {
        return this.touch(identifier).startOrigin() as InstanceType<T[ 'quarkClass' ]>
    }


    // return quark if it exists and is non-shadowing, otherwise undefined
    acquireQuarkIfExists<T extends Identifier> (identifier : T) : InstanceType<T[ 'quarkClass' ]> | undefined {
        const entry     = this.entries.get(identifier)

        return entry && entry.origin === entry ? entry.origin as InstanceType<T[ 'quarkClass' ]> : undefined
    }


    touch (identifier : Identifier) : Quark {
        this.walkContext.continueFrom([ identifier ])

        const entry                 = this.entries.get(identifier)

        entry.forceCalculation()

        return entry
    }


    hasIdentifier (identifier : Identifier) : boolean {
        return Boolean(this.entries.get(identifier) || this.baseRevision.getLatestEntryFor(identifier))
    }


    // this is actually an optimized version of `write`, which skips the graph walk phase
    // (since the identifier is assumed to be new, there should be no dependent quarks)
    addIdentifier (identifier : Identifier, proposedValue? : any, ...args : any[]) : Quark {
        // however, the identifier may be already in the transaction, for example if the `write` method
        // of some other identifier writes to this identifier
        let entry : Quark           = this.entries.get(identifier)

        const isVariable            = identifier.level === Levels.UserInput

        if (!entry) {
            entry                   = identifier.newQuark(this.baseRevision)

            entry.previous          = this.baseRevision.getLatestEntryFor(identifier)

            entry.forceCalculation()

            this.entries.set(identifier, entry)
            if (!identifier.lazy && !isVariable) this.stackGen.push(entry)
        }

        if (proposedValue !== undefined || isVariable) {
            // TODO change to `this.write()`
            entry.startOrigin()
            identifier.write.call(identifier.context || identifier, identifier, this, entry, proposedValue === undefined && isVariable ? null : proposedValue, ...args)
        }

        return entry
    }


    removeIdentifier (identifier : Identifier) {
        identifier.leaveGraph(this.graph)

        const entry                 = this.touch(identifier).startOrigin()

        entry.setValue(TombStone)
    }


    populateCandidateScopeFromTransitions (candidate : Revision, scope : Map<Identifier, Quark>) {
        if (candidate.scope.size === 0) {
            // in this branch we can overwrite the whole map
            candidate.scope     = scope
        } else {
            // in this branch candidate's scope already has some content - this is the case for calculating lazy values

            // // TODO benchmark what is faster (for small maps) - `map.forEach(entry => {})` or `for (const entry of map) {}`
            // entries.forEach((entry : QuarkEntry, identifier : Identifier) => {
            //     candidate.scope.set(identifier, entry)
            // })

            for (const [ identifier, quark ] of scope) {
                if (quark.isShadow()) {
                    const latestEntry   = candidate.getLatestEntryFor(identifier)

                    // TODO remove the origin/shadowing concepts? this line won't be needed then
                    // and we iterate over the edges from "origin" anyway
                    quark.getOutgoing().forEach((toQuark, toIdentifier) => latestEntry.getOutgoing().set(toIdentifier, toQuark))

                } else {
                    candidate.scope.set(identifier, quark)
                }
            }
        }
    }


    preCommit (args? : CommitArguments) {
        if (this.isClosed) throw new Error('Can not propagate closed revision')

        this.markSelfDependent()

        this.isClosed               = true
        this.propagationStartDate   = Date.now()

        this.plannedTotalIdentifiersToCalculate = this.stackGen.length
    }


    postCommit () : TransactionCommitResult {
        this.populateCandidateScopeFromTransitions(this.candidate, this.entries)

        // won't be available after next line
        const entries               = this.entries

        // for some reason need to cleanup the `walkContext` manually, otherwise the extra revisions hangs in memory
        this.walkContext            = undefined

        return { revision : this.candidate, entries }
    }


    commit (args? : CommitArguments) : TransactionCommitResult {
        this.preCommit(args)

        this.calculateTransitionsSync(this.onEffectSync)
        // runGeneratorSyncWithEffect(this.onEffectSync, this.calculateTransitionsStackGen, [ this.onEffectSync, stack ], this)

        return this.postCommit()
    }


    // // propagation that does not use generators at all
    // propagateSync (args? : PropagateArguments) : TransactionPropagateResult {
    //     const stack = this.prePropagate(args)
    //
    //     this.calculateTransitionsStackSync(this.onEffectSync, stack)
    //     // runGeneratorSyncWithEffect(this.onEffectSync, this.calculateTransitionsStackGen, [ this.onEffectSync, stack ], this)
    //
    //     return this.postPropagate()
    // }


    async commitAsync (args? : CommitArguments) : Promise<TransactionCommitResult> {
        this.preCommit(args)

        return this.ongoing = this.ongoing.then(() => {
            return runGeneratorAsyncWithEffect(this.onEffectAsync, this.calculateTransitions, [ this.onEffectAsync ], this)
        }).then(() => {
            return this.postCommit()
        })

        // await runGeneratorAsyncWithEffect(this.onEffectAsync, this.calculateTransitions, [ this.onEffectAsync ], this)
        //
        // return this.postCommit()
    }


    [ProposedOrCurrentSymbol] (effect : Effect, activeEntry : Quark) : any {
        activeEntry.usedProposedOrCurrent = true

        const proposedValue     = activeEntry.getProposedValue(this)

        if (proposedValue !== undefined) return proposedValue

        const baseRevision      = this.baseRevision
        const identifier        = activeEntry.identifier
        const latestEntry       = baseRevision.getLatestEntryFor(identifier)

        if (latestEntry === activeEntry) {
            return baseRevision.previous ? baseRevision.previous.read(identifier) : undefined
        } else {
            return latestEntry ? baseRevision.read(identifier) : undefined
        }
    }


    [TransactionSymbol] (effect : Effect, activeEntry : Quark) : any {
        return this
    }


    [OwnQuarkSymbol] (effect : Effect, activeEntry : Quark) : any {
        return activeEntry
    }


    [OwnIdentifierSymbol] (effect : Effect, activeEntry : Quark) : any {
        return activeEntry.identifier
    }


    [WriteSymbol] (effect : WriteEffect, activeEntry : Quark) : undefined | typeof BreakCurrentStackExecution {
        if (activeEntry.identifier.lazy) throw new Error('Lazy identifiers can not use `Write` effect')

        const writeToHigherLevel    = effect.identifier.level > activeEntry.identifier.level

        if (!writeToHigherLevel) this.walkContext.startNewEpoch()

        this.write(effect.identifier, ...effect.proposedArgs)

        // // this.writes.push(effect)
        //
        // // const writeTo   = effect.identifier
        // //
        // // writeTo.write.call(writeTo.context || writeTo, writeTo, this, null, ...effect.proposedArgs)
        //
        // this.onNewWrite()
        return writeToHigherLevel ? undefined : BreakCurrentStackExecution
    }


    [WriteSeveralSymbol] (effect : WriteSeveralEffect, activeEntry : Quark) : undefined | typeof BreakCurrentStackExecution {
        if (activeEntry.identifier.lazy) throw new Error('Lazy identifiers can not use `Write` effect')

        let writeToHigherLevel    = true

        // effect.writes.forEach(writeInfo => {
        effect.writes.forEach(writeInfo => {
            if (writeInfo.identifier.level <= activeEntry.identifier.level && writeToHigherLevel) {
                this.walkContext.startNewEpoch()

                writeToHigherLevel = false
            }

            this.write(writeInfo.identifier, ...writeInfo.proposedArgs)
        })

            // const identifier    = writeInfo.identifier
            //
            // identifier.write.call(identifier.context || identifier, identifier, this, null, ...writeInfo.proposedArgs)
        // })

        // this.onNewWrite()

        return writeToHigherLevel ? undefined : BreakCurrentStackExecution
    }


    [PreviousValueOfSymbol] (effect : PreviousValueOfEffect, activeEntry : Quark) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        return this.baseRevision.readIfExists(source)
    }


    [ProposedValueOfSymbol] (effect : ProposedValueOfEffect, activeEntry : Quark) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        const quark     = this.entries.get(source)

        const proposedValue = quark && !quark.isShadow() ? quark.getProposedValue(this) : undefined

        return proposedValue
    }


    [HasProposedValueSymbol] (effect : ProposedValueOfEffect, activeEntry : Quark) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        const quark     = this.entries.get(source)

        return quark ? quark.hasProposedValue() : false
    }


    [ProposedOrPreviousValueOfSymbol] (effect : ProposedValueOfEffect, activeEntry : Quark) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        return this.readProposedOrPrevious(source)
    }


    [UnsafeProposedOrPreviousValueOfSymbol] (effect : ProposedValueOfEffect, activeEntry : Quark) : any {
        return this.readProposedOrPrevious(effect.identifier)
    }


    [ProposedArgumentsOfSymbol] (effect : ProposedValueOfEffect, activeEntry : Quark) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        const quark     = this.entries.get(source)

        return quark && !quark.isShadow() ? quark.proposedArguments : undefined
    }


    getLatestEntryFor (identifier : Identifier) : Quark {
        let entry : Quark             = this.entries.get(identifier) || this.baseRevision.getLatestEntryFor(identifier)

        if (entry.getValue() === TombStone) return undefined

        return entry
    }


    addEdge (identifierRead : Identifier, activeEntry : Quark, type : EdgeType) : Quark {
        const identifier    = activeEntry.identifier

        if (identifier.level < identifierRead.level) throw new Error('Identifier can not read from higher level identifier')

        let entry : Quark             = this.entries.get(identifierRead)

        // creating "shadowing" entry, to store the new edges
        if (!entry) {
            const previousEntry = this.baseRevision.getLatestEntryFor(identifierRead)

            if (!previousEntry) throwUnknownIdentifier(identifierRead)

            entry               = identifierRead.newQuark(this.baseRevision)

            previousEntry.origin && entry.setOrigin(previousEntry.origin)
            entry.previous      = previousEntry

            this.entries.set(identifierRead, entry)
        }

        entry.addOutgoingTo(activeEntry, type)

        return entry
    }


    onQuarkCalculationCompleted (entry : Quark, value : any) {
        // cleanup the iterator
        entry.cleanup()

        const identifier    = entry.identifier
        const previousEntry = entry.previous

        //--------------------
        const sameAsPrevious    = Boolean(previousEntry && previousEntry.hasValue() && identifier.equality(value, previousEntry.getValue()))

        if (sameAsPrevious) {
            previousEntry.outgoingInTheFutureAndPastCb(this.baseRevision, previousOutgoingEntry => {
                const outgoingEntry = this.entries.get(previousOutgoingEntry.identifier)

                if (outgoingEntry) outgoingEntry.edgesFlow--
            })

            entry.setOrigin(previousEntry.origin)

            // this is to indicate that this entry should be recalculated (origin removed)
            // see `resetToEpoch`
            entry.value     = value
        } else {
            entry.startOrigin()
            entry.setValue(value)
        }

        //--------------------
        let ignoreSelfDependency : boolean = false

        if (entry.usedProposedOrCurrent) {
            if (entry.proposedValue !== undefined) {
                if (identifier.equality(value, entry.proposedValue)) ignoreSelfDependency = true
            } else {
                // ignore the uninitialized atoms (`proposedValue` === undefined && !previousEntry)
                // which has been calculated to `null` - we don't consider this as a change
                if (sameAsPrevious || (!previousEntry && value === null)) ignoreSelfDependency = true
            }

            if (!ignoreSelfDependency) this.candidate.selfDependent.add(identifier)
        }
    }


    onReadIdentifier (identifierRead : Identifier, activeEntry : Quark, stack : Quark[]) : IteratorResult<any> | undefined {
        const requestedEntry            = this.addEdge(identifierRead, activeEntry, EdgeTypeNormal)

        if (requestedEntry.hasValue()) {
            const value                 = requestedEntry.getValue()

            if (value === TombStone) throwUnknownIdentifier(identifierRead)

            return activeEntry.continueCalculation(value)
        }
        else if (requestedEntry.isShadow()) {
            // shadow entry is shadowing a quark w/o value - it is still transitioning or lazy
            // in both cases start new calculation
            requestedEntry.startOrigin()
            requestedEntry.forceCalculation()

            stack.push(requestedEntry)

            return undefined
        }
        else {
            if (!requestedEntry.isCalculationStarted()) {
                stack.push(requestedEntry)

                if (!requestedEntry.previous || !requestedEntry.previous.hasValue()) requestedEntry.forceCalculation()

                return undefined
            }
            else {
                // cycle - the requested quark has started calculation (means it was encountered in the calculation loop before)
                // but the calculation did not complete yet (even that requested quark is calculated before the current)

                let cycle : ComputationCycle

                const walkContext = TransactionCycleDetectionWalkContext.new({
                    transaction         : this,
                    onCycle (node : Identifier, stack : WalkStep<Identifier>[]) : OnCycleAction {
                        cycle       = ComputationCycle.new({ cycle : cycleInfo(stack) })

                        return OnCycleAction.Cancel
                    }
                })

                walkContext.startFrom([ requestedEntry.identifier ])

                if (!cycle) debugger

                // debugger

                // console.log(cycle)

                // debugger
                throw new Error("Computation cycle: " + cycle)
                // yield GraphCycleDetectedEffect.new()
            }
        }
    }


    * calculateTransitions (context : CalculationContext<any>) : Generator<any, void, unknown> {
        const queue                             = this.stackGen

        while (queue.length) {
            yield* this.calculateTransitionsStackGen(context, queue.takeLowestLevel())
        }
    }


    calculateTransitionsSync (context : CalculationContext<any>) {
        const queue                             = this.stackGen

        while (queue.length) {
            this.calculateTransitionsStackSync(context, queue.takeLowestLevel())
        }
    }


    // this method is not decomposed into smaller ones intentionally, as that makes benchmarks worse
    // it seems that overhead of calling few more functions in such tight loop as this outweighs the optimization
    * calculateTransitionsStackGen (context : CalculationContext<any>, stack : Quark[]) : Generator<any, void, unknown> {
        this.walkContext.startNewEpoch()

        const entries                       = this.entries
        const propagationStartDate          = this.propagationStartDate

        const enableProgressNotifications   = this.graph ? this.graph.enableProgressNotifications : false

        let counter : number                = 0

        const prevActiveStack               = this.activeStack

        this.activeStack = stack

        while (stack.length) {
            if (enableProgressNotifications && !(counter++ % this.emitProgressNotificationsEveryCalculations)) {
                const now               = Date.now()
                const elapsed           = now - propagationStartDate

                if (elapsed > this.startProgressNotificationsAfterMs) {
                    const lastProgressNotificationDate      = this.lastProgressNotificationDate

                    if (!lastProgressNotificationDate || (now - lastProgressNotificationDate) > this.emitProgressNotificationsEveryMs) {
                        this.lastProgressNotificationDate   = now

                        this.graph.onPropagationProgressNotification({
                            total       : this.plannedTotalIdentifiersToCalculate,
                            remaining   : stack.length,
                            phase       : 'propagating'
                        })

                        yield delay(0)
                    }
                }
            }

            const entry             = stack[ stack.length - 1 ]
            const identifier        = entry.identifier

            // TODO can avoid `.get()` call by comparing some another "epoch" counter on the entry
            const ownEntry          = entries.get(identifier)
            if (ownEntry !== entry) {
                entry.cleanup()

                stack.pop()
                continue
            }

            if (entry.edgesFlow == 0) {
                // even if we delete the entry there might be other copies in stack, so reduce the `edgesFlow` to -1
                // to indicate that those are already processed
                entry.edgesFlow--

                const previousEntry = entry.previous

                previousEntry && previousEntry.outgoingInTheFutureAndPastCb(this.baseRevision, outgoing => {
                    const outgoingEntry     = entries.get(outgoing.identifier)

                    if (outgoingEntry) outgoingEntry.edgesFlow--
                })
            }

            // the "edgesFlow < 0" indicates that none of the incoming deps of this quark has changed
            // thus we don't need to calculate it, moreover, we can remove the quark from the `entries`
            // to expose the value from the previous revision
            // however, we only do it, when there is a quark from previous revision and it has "origin" (some value)
            if (entry.edgesFlow < 0 && entry.previous && entry.previous.origin) {
                // even if the entry will be deleted from the transaction, we set the correct origin for it
                // this is because there might be other references to this entry in the stack
                // and also the entry may be referenced as dependency of some other quark
                // in such case the correct `originId` will preserve dependency during revisions compactification
                entry.setOrigin(entry.previous.origin)

                // if there's no outgoing edges we remove the quark
                if (!entry.hasOutgoingEdges()) {
                    entries.delete(identifier)
                }

                // reduce garbage collection workload
                entry.cleanup()

                stack.pop()
                continue
            }

            if (/*entry.isShadow() ||*/ entry.hasValue()) {
                entry.cleanup()

                stack.pop()
                continue
            }

            const startedAtEpoch    = entry.visitEpoch

            let iterationResult : IteratorResult<any>   = entry.isCalculationStarted() ? entry.iterationResult : entry.startCalculation(this.onEffectSync)

            while (iterationResult) {
                const value         = iterationResult.value === undefined ? null : iterationResult.value

                if (entry.isCalculationCompleted()) {
                    if (entry.visitEpoch == startedAtEpoch) {
                        this.onQuarkCalculationCompleted(entry, value)
                    }

                    stack.pop()
                    break
                }
                else if (value instanceof Identifier) {
                    iterationResult     = this.onReadIdentifier(value, entry, stack)
                }
                else if (value === SynchronousCalculationStarted) {
                    // the fact, that we've encountered `SynchronousCalculationStarted` constant can mean 2 things:
                    // 1) there's a cycle during synchronous computation (we throw exception in `read` method)
                    // 2) some other computation is reading synchronous computation, that has already started
                    //    in such case its safe to just unwind the stack

                    stack.pop()
                    break
                }
                else {
                    // bypass the unrecognized effect to the outer context
                    const effectResult          = yield value

                    // the calculation can be interrupted (`cleanupCalculation`) as a result of the effect (WriteEffect)
                    // in such case we can not continue calculation and just exit the inner loop
                    if (effectResult === BreakCurrentStackExecution) break

                    // // the calculation can be interrupted (`cleanupCalculation`) as a result of the effect (WriteEffect)
                    // // in such case we can not continue calculation and just exit the inner loop
                    // if (entry.iterationResult)
                    iterationResult         = entry.continueCalculation(effectResult)
                    // else
                    //     iterationResult         = null
                }
            }
        }

        this.activeStack    = prevActiveStack
    }


    // THIS METHOD HAS TO BE KEPT SYNCED WITH THE `calculateTransitionsStackGen` !!!
    calculateTransitionsStackSync (context : CalculationContext<any>, stack : Quark[]) {
        this.walkContext.startNewEpoch()

        const entries                       = this.entries

        const prevActiveStack               = this.activeStack

        this.activeStack = stack

        while (stack.length) {
            const entry             = stack[ stack.length - 1 ]
            const identifier        = entry.identifier

            // TODO can avoid `.get()` call by comparing some another "epoch" counter on the entry
            const ownEntry          = entries.get(identifier)
            if (ownEntry !== entry) {
                entry.cleanup()

                stack.pop()
                continue
            }

            if (entry.edgesFlow == 0) {
                // even if we delete the entry there might be other copies in stack, so reduce the `edgesFlow` to -1
                // to indicate that those are already processed
                entry.edgesFlow--

                const previousEntry = entry.previous

                previousEntry && previousEntry.outgoingInTheFutureAndPastCb(this.baseRevision, outgoing => {
                    const outgoingEntry     = entries.get(outgoing.identifier)

                    if (outgoingEntry) outgoingEntry.edgesFlow--
                })
            }

            // the "edgesFlow < 0" indicates that none of the incoming deps of this quark has changed
            // thus we don't need to calculate it, moreover, we can remove the quark from the `entries`
            // to expose the value from the previous revision
            // however, we only do it, when there is a quark from previous revision and it has "origin" (some value)
            if (entry.edgesFlow < 0 && entry.previous && entry.previous.origin) {
                // even if the entry will be deleted from the transaction, we set the correct origin for it
                // this is because there might be other references to this entry in the stack
                // and also the entry may be referenced as dependency of some other quark
                // in such case the correct `originId` will preserve dependency during revisions compactification
                entry.setOrigin(entry.previous.origin)

                // if there's no outgoing edges we remove the quark
                if (!entry.hasOutgoingEdges()) {
                    entries.delete(identifier)
                }

                // reduce garbage collection workload
                entry.cleanup()

                stack.pop()
                continue
            }

            if (/*entry.isShadow() ||*/ entry.hasValue()) {
                entry.cleanup()

                stack.pop()
                continue
            }

            const startedAtEpoch    = entry.visitEpoch

            let iterationResult : IteratorResult<any>   = entry.isCalculationStarted() ? entry.iterationResult : entry.startCalculation(this.onEffectSync)

            while (iterationResult) {
                const value         = iterationResult.value === undefined ? null : iterationResult.value

                if (entry.isCalculationCompleted()) {
                    if (entry.visitEpoch == startedAtEpoch) {
                        this.onQuarkCalculationCompleted(entry, value)
                    }

                    stack.pop()
                    break
                }
                else if (value instanceof Identifier) {
                    iterationResult     = this.onReadIdentifier(value, entry, stack)
                }
                else if (value === SynchronousCalculationStarted) {
                    // the fact, that we've encountered `SynchronousCalculationStarted` constant can mean 2 things:
                    // 1) there's a cycle during synchronous computation (we throw exception in `read` method)
                    // 2) some other computation is reading synchronous computation, that has already started
                    //    in such case its safe to just unwind the stack

                    stack.pop()
                    break
                }
                else {
                    // bypass the unrecognized effect to the outer context
                    const effectResult          = context(value)

                    if (effectResult instanceof Promise)
                        throw new Error("Effect resolved to promise in the synchronous context, check that you marked the asynchronous calculations accordingly")

                    // the calculation can be interrupted (`cleanupCalculation`) as a result of the effect (WriteEffect)
                    // in such case we can not continue calculation and just exit the inner loop
                    if (effectResult === BreakCurrentStackExecution) break

                    // // the calculation can be interrupted (`cleanupCalculation`) as a result of the effect (WriteEffect)
                    // // in such case we can not continue calculation and just exit the inner loop
                    // if (entry.iterationResult)
                    iterationResult         = entry.continueCalculation(effectResult)
                    // else
                    //     iterationResult         = null
                }
            }
        }

        this.activeStack    = prevActiveStack
    }
}
