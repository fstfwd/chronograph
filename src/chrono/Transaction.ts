import { AnyConstructor, Base, Mixin } from "../class/Mixin.js"
import { NOT_VISITED, OnCycleAction, VisitInfo, WalkContext, WalkStep } from "../graph/WalkDepth.js"
import {
    CalculationContext,
    runGeneratorAsyncWithEffect,
    runGeneratorSyncWithEffect,
    SynchronousCalculationStarted
} from "../primitives/Calculation.js"
import { delay } from "../util/Helpers.js"
import { LeveledStack } from "../util/LeveledStack.js"
import { CheckoutI, PropagateArguments } from "./Checkout.js"
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
import { Identifier, throwUnknownIdentifier } from "./Identifier.js"
import { EdgeType, Quark, QuarkI, TombStone } from "./Quark.js"
import { MinimalRevision, Revision, RevisionI, Scope } from "./Revision.js"


//---------------------------------------------------------------------------------------------------------------------
export type NotPromise<T> = T extends Promise<any> ? never : T

export type YieldableValue = Effect | Identifier

export type SyncEffectHandler = <T extends any>(effect : YieldableValue) => T & NotPromise<T>
export type AsyncEffectHandler = <T extends any>(effect : YieldableValue) => Promise<T>


//---------------------------------------------------------------------------------------------------------------------
// weird stack overflow on 1300 deep benchmark, when using `EdgeType.Normal` w/o aliasing it to constant first

export const EdgeTypeNormal    = EdgeType.Normal
export const EdgeTypePast      = EdgeType.Past


//---------------------------------------------------------------------------------------------------------------------
export class WalkForwardOverwriteContext extends WalkContext<Identifier> {
    visited         : Map<Identifier, Quark>

    baseRevision    : Revision

    pushTo          : LeveledStack<Quark>


    setVisitedInfo (identifier : Identifier, visitedAt : number, entry : Quark) : VisitInfo {
        if (!entry) {
            entry      = identifier.newQuark()

            this.visited.set(identifier, entry)
        }

        entry.visitedAt    = visitedAt

        if (entry.visitEpoch !== this.currentEpoch) {
            entry.visitEpoch   = this.currentEpoch

            entry.visitedAt     = NOT_VISITED
            entry.edgesFlow     = 0

            entry.cleanupCalculation()
            if (entry.outgoing) entry.outgoing.clear()
            if (entry.origin && entry.origin === entry) entry.origin.value = undefined
        }

        return entry
    }


    onTopologicalNode (identifier : Identifier) {
        if (!identifier.lazy) this.pushTo.push(this.visited.get(identifier))
    }


    onCycle (node : Identifier, stack : WalkStep<Identifier>[]) : OnCycleAction {
        return OnCycleAction.Resume
    }


    doCollectNext (from : Identifier, identifier : Identifier, toVisit : WalkStep<Identifier>[]) {
        let entry : Quark   = this.visited.get(identifier)

        if (!entry) {
            entry           = identifier.newQuark()

            this.visited.set(identifier, entry)
        }

        if (entry.visitEpoch < this.currentEpoch) {
            entry.visitEpoch    = this.currentEpoch
            entry.visitedAt     = NOT_VISITED
            entry.edgesFlow     = 0

            entry.cleanupCalculation()
            if (entry.outgoing) entry.outgoing.clear()
            if (entry.origin && entry.origin === entry) entry.origin.value = undefined
        }

        entry.edgesFlow++

        toVisit.push({ node : identifier, from : from, label : undefined })
    }


    collectNext (node : Identifier, toVisit : WalkStep<Identifier>[], visitInfo : Quark) {
        const latestEntry       = this.baseRevision.getLatestEntryFor(node)

        // newly created identifier
        if (!latestEntry) return

        // since `collectNext` is called exactly once for every node, all nodes (which are transitions)
        // will have the `previous` property populated
        visitInfo.previous      = latestEntry

        if (node.lazy && latestEntry.origin && latestEntry.origin.usedProposedOrCurrent) {
            // for lazy quarks, that depends on the `ProposedOrCurrent` effect, we need to save the value or proposed value
            // from the previous revision
            // this is because that, for "historyLimit = 1", the previous revision's data will be completely overwritten by the new one
            // so general consideration is - the revision should contain ALL information needed to calculate it
            // alternatively, this could be done during the `populateCandidateScopeFromTransitions`
            visitInfo.getQuark().proposedValue   = latestEntry.origin.value
        }

        let currentEntry : Quark    = latestEntry

        // TODO remove the origin/shadowing concepts?
        // we iterate over the edges from "origin" anyway
        do {
            for (const outgoingEntry of currentEntry.outgoing.keys()) {
                const identifier    = outgoingEntry.identifier

                if (outgoingEntry.origin === this.baseRevision.getLatestEntryFor(identifier).origin) {
                    this.doCollectNext(node, identifier, toVisit)
                }
            }

            if (currentEntry.isShadow())
                currentEntry = currentEntry.previous
            else
                break

        } while (true)

        for (const outgoingEntry of visitInfo.outgoing.keys()) {
            const identifier    = outgoingEntry.identifier

            this.doCollectNext(node, identifier, toVisit)
        }
    }
}


//---------------------------------------------------------------------------------------------------------------------
export type TransactionPropagateResult = { revision : Revision, entries : Scope }


//---------------------------------------------------------------------------------------------------------------------
export const Transaction = <T extends AnyConstructor<Base>>(base : T) =>

class Transaction extends base {
    baseRevision            : RevisionI             = undefined

    candidate               : RevisionI             = undefined

    graph                   : CheckoutI             = undefined

    isClosed                : boolean               = false

    walkContext             : WalkForwardOverwriteContext   = undefined

    // we use 2 different stacks, because they support various effects
    stackSync               : LeveledStack<QuarkI>  = new LeveledStack()
    // the `stackGen` supports async effects notably
    stackGen                : LeveledStack<QuarkI>  = new LeveledStack()

    activeStack             : QuarkI[]

    onEffectSync            : SyncEffectHandler     = undefined
    onEffectAsync           : AsyncEffectHandler    = undefined

    //---------------------
    propagationStartDate            : number        = 0
    lastProgressNotificationDate    : number        = 0

    startProgressNotificationsAfterMs : number      = 500
    emitProgressNotificationsEveryMs  : number      = 200

    emitProgressNotificationsEveryCalculations  : number = 100

    plannedTotalIdentifiersToCalculate  : number    = 0


    initialize (...args) {
        super.initialize(...args)

        this.walkContext    = WalkForwardOverwriteContext.new({
            baseRevision    : this.baseRevision,
            pushTo          : this.stackGen
            // // ignore cycles when determining potentially changed atoms
            // onCycle         : (quark : Identifier, stack : WalkStep<Identifier>[]) => OnCycleAction.Resume,
            //
            // onTopologicalNode       : (identifier : Identifier) => {
            //     if (!identifier.lazy) this.stackGen.push(this.entries.get(identifier))
            // }
        })

        if (!this.candidate) this.candidate = MinimalRevision.new({ previous : this.baseRevision })

        // the `onEffectSync` should be bound to the `yieldSync` of course, and `yieldSync` should look like:
        //     yieldSync (effect : YieldableValue) : any {
        //         if (effect instanceof Identifier) return this.read(effect)
        //     }
        // however, the latter consumes more stack frames - every read goes through `yieldSync`
        // since `read` is the most used effect anyway, we bind `onEffectSync` to `read` and
        // instead inside of `read` delegate to `yieldSync` for non-identifiers
        this.onEffectSync   = this.read.bind(this)
        this.onEffectAsync  = this.yieldAsync.bind(this)
    }


    get entries () : Map<Identifier, QuarkI> {
        return this.walkContext.visited
    }


    isEmpty () : boolean {
        return this.entries.size === 0
    }


    getActiveEntry () : QuarkI {
        return this.activeStack[ this.activeStack.length - 1 ]

        // // `stackSync` is always empty, except when the synchronous "batch" is being processed
        // const activeStack   = this.stackSync.length > 0 ? this.stackSync : this.stackGen
        //
        // return activeStack.last()
    }


    async yieldAsync (effect : Effect) : Promise<any> {
        if (effect instanceof Promise) {
            return await effect
        }

        return this[ effect.handler ](effect, this.getActiveEntry())
    }


    // see the comment for the `onEffectSync`
    yieldSync (effect : Effect) : any {
        return this[ effect.handler ](effect, this.getActiveEntry())
    }


    // TODO merge into `yieldSync` ??
    read (identifier : Identifier) : any {
        // see the comment for the `onEffectSync`
        if (!(identifier instanceof Identifier)) return this.yieldSync(identifier as Effect)

        //----------------------
        let entry           = this.entries.get(identifier)

        // creating "shadowing" entry, to store the new edges
        if (!entry) {
            const latestEntry       = this.baseRevision.getLatestEntryFor(identifier)

            if (!latestEntry) throwUnknownIdentifier(identifier)

            entry                   = identifier.quarkClass.new({ identifier, origin : latestEntry.origin, previous : latestEntry, needToBuildProposedValue : identifier.proposedValueIsBuilt })

            this.entries.set(identifier, entry)
        }

        //----------------------
        const activeEntry   = this.getActiveEntry()

        if (activeEntry.identifier.level < entry.identifier.level) throw new Error('Identifier can not read from higher level identifier')

        entry.getOutgoing().set(activeEntry, EdgeTypeNormal)

        //----------------------
        if (entry.hasValue()) return entry.getValue()

        //----------------------
        entry.forceCalculation()

        this.stackSync.push(entry)

        this.calculateTransitionsStackSync(this.onEffectSync, this.stackSync)

        if (!entry.hasValue()) throw new Error('Cycle during synchronous computation')

        return entry.getValue()
    }


    readDirty (identifier : Identifier) : any {
        const dirtyQuark    = this.entries.get(identifier)

        if (dirtyQuark && dirtyQuark.proposedValue !== undefined) {
            return dirtyQuark.proposedValue
        } else
            return this.baseRevision.readIfExists(identifier)
    }


    write (identifier : Identifier, proposedValue : any, ...args : any[]) {
        identifier.write.call(identifier.context || identifier, identifier, this, proposedValue, ...args)
    }


    acquireQuark<T extends Identifier> (identifier : T) : InstanceType<T[ 'quarkClass' ]> {
        return this.touch(identifier).getQuark() as InstanceType<T[ 'quarkClass' ]>
    }


    // return quark if it exists and is non-shadowing, otherwise undefined
    acquireQuarkIfExists<T extends Identifier> (identifier : T) : InstanceType<T[ 'quarkClass' ]> | undefined {
        const entry     = this.entries.get(identifier)

        return entry && entry.origin === entry ? entry.origin as InstanceType<T[ 'quarkClass' ]> : undefined
    }


    touch (identifier : Identifier) : QuarkI {
        this.walkContext.continueFrom([ identifier ])

        const entry                 = this.entries.get(identifier)

        entry.forceCalculation()

        return entry
    }


    removeIdentifier (identifier : Identifier) {
        const entry                 = this.touch(identifier)

        entry.acquireQuark().value  = TombStone

        //TODO cleanup
        //@ts-ignore
        //identifier.DATA             = this.readDirty(identifier)
    }


    populateCandidateScopeFromTransitions (candidate : RevisionI, entries : Map<Identifier, QuarkI>) {
        if (candidate.scope.size === 0) {
            // in this branch we can overwrite the whole map
            candidate.scope     = entries

            // its important to clear the transitions, since that reduces garbage collection workload
            // (improves the `benchmark_sync` significantly)
            // we do it manually, right after the calculation of every quark completes
            // so strictly speaking this code is not needed, but, it definitely feels, like
            // it improves the `benchmark_sync`
            // perhaps, because all `entries` are accessed sequentially, they are cached in some internal CPU caches
            // for (const entry of entries.values()) {
            //     // this code can be uncommented to check if we leak transitions somewhere
            //     // if (entry.transition) debugger
            //
            //     entry.transition    = undefined
            // }
        } else {
            // in this branch candidate's scope already has some content - this is the case for calculating lazy values


            // // TODO benchmark what is faster (for small maps) - `map.forEach(entry => {})` or `for (const entry of map) {}`
            // entries.forEach((entry : QuarkEntry, identifier : Identifier) => {
            //     candidate.scope.set(identifier, entry)
            //
            //     entry.transition    = null
            // })

            for (const [ identifier, entry ] of entries) {
                if (entry.isShadow()) {
                    const latestEntry   = candidate.getLatestEntryFor(identifier)

                    // TODO remove the origin/shadowing concepts? this line won't be needed then
                    // and we iterate over the edges from "origin" anyway
                    entry.outgoing.forEach((toEntry, toIdentifier) => latestEntry.outgoing.set(toIdentifier, toEntry))

                } else {
                    candidate.scope.set(identifier, entry)
                }

                // entry.transition    = undefined
            }
        }
    }


    prePropagate (args? : PropagateArguments) : LeveledStack<QuarkI> {
        if (this.isClosed) throw new Error('Can not propagate closed revision')

        this.isClosed               = true
        this.propagationStartDate   = Date.now()

        let stack : LeveledStack<Quark>

        if (args && args.calculateOnly) {
            const calculateOnly     = args.calculateOnly

            stack                   = new LeveledStack()

            let maxLevel : number   = 0

            for (let i = 0; i < calculateOnly.length; i++) {
                const identifier    = calculateOnly[ i ]

                if (identifier.level > maxLevel) maxLevel = identifier.level

                const entry = this.entries.get(identifier) || identifier.newQuark()

                entry.forceCalculation()

                stack.push(entry)
            }

            for (let i = 0; i < maxLevel; i++) {
                const dirtyLayer    = this.stackGen.levels[ i ]

                if (dirtyLayer) {
                    const existingLevel = stack.levels[ i ]

                    if (existingLevel) {
                        existingLevel.push.apply(existingLevel, dirtyLayer)
                    } else {
                        stack.levels[ i ] = dirtyLayer.slice()
                    }

                    stack.length        += dirtyLayer.length
                }
            }

            stack.resetCachedPosition()
        } else
            stack                   = this.stackGen

        // if (this.baseRevision.selfDependentQuarks.size > 0) debugger

        for (const selfDependentQuark of this.baseRevision.selfDependentQuarks) this.touch(selfDependentQuark)

        this.plannedTotalIdentifiersToCalculate = stack.length

        return stack
    }


    postPropagate () : TransactionPropagateResult {
        this.populateCandidateScopeFromTransitions(this.candidate, this.entries)

        // won't be available after next line
        const entries               = this.entries

        // for some reason need to cleanup the `walkContext` manually, otherwise the extra revisions hangs in memory
        this.walkContext            = undefined

        return { revision : this.candidate, entries }
    }


    propagate (args? : PropagateArguments) : TransactionPropagateResult {
        const stack = this.prePropagate(args)

        runGeneratorSyncWithEffect(this.onEffectSync, this.calculateTransitionsStackGen, [ this.onEffectSync, stack ], this)

        return this.postPropagate()
    }


    // propagation that does not use generators at all
    propagateSync (args? : PropagateArguments) : TransactionPropagateResult {
        const stack = this.prePropagate(args)

        this.calculateTransitionsStackSync(this.onEffectSync, stack)

        return this.postPropagate()
    }


    async propagateAsync (args? : PropagateArguments) : Promise<TransactionPropagateResult> {
        const stack = this.prePropagate(args)

        // TODO should check the `async` flag of the effect and do not do `await` if not needed
        await runGeneratorAsyncWithEffect(this.onEffectAsync, this.calculateTransitionsStackGen, [ this.onEffectSync, stack ], this)

        return this.postPropagate()
    }


    [ProposedOrCurrentSymbol] (effect : Effect, activeEntry : QuarkI) : any {
        const quark             = activeEntry.acquireQuark()

        quark.usedProposedOrCurrent      = true

        const proposedValue     = quark.getProposedValue(this)

        if (proposedValue !== undefined) return proposedValue

        const baseRevision      = this.baseRevision
        const identifier        = activeEntry.identifier
        const latestEntry       = baseRevision.getLatestEntryFor(identifier)

        if (latestEntry === activeEntry) {
            return baseRevision.previous ? baseRevision.previous.read(identifier) : undefined
        } else {
            return latestEntry ? baseRevision.read(identifier) : null
        }
    }


    [TransactionSymbol] (effect : Effect, activeEntry : QuarkI) : any {
        return this
    }


    [OwnQuarkSymbol] (effect : Effect, activeEntry : QuarkI) : any {
        return activeEntry
    }


    [OwnIdentifierSymbol] (effect : Effect, activeEntry : QuarkI) : any {
        return activeEntry.identifier
    }


    [WriteSymbol] (effect : WriteEffect, activeEntry : QuarkI) : any {
        if (activeEntry.identifier.lazy) throw new Error('Lazy identifiers can not use `Write` effect')

        this.walkContext.currentEpoch++

        const writeTo   = effect.writeTarget

        writeTo.write.call(writeTo.context || writeTo, writeTo, this, ...effect.proposedArgs)
    }


    [WriteSeveralSymbol] (effect : WriteSeveralEffect, activeEntry : QuarkI) : any {
        if (activeEntry.identifier.lazy) throw new Error('Lazy identifiers can not use `Write` effect')

        this.walkContext.currentEpoch++

        effect.writes.forEach(writeInfo => {
            const identifier    = writeInfo.identifier

            identifier.write.call(identifier.context || identifier, identifier, this, ...writeInfo.proposedArgs)
        })
    }


    [PreviousValueOfSymbol] (effect : PreviousValueOfEffect, activeEntry : QuarkI) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        return this.baseRevision.readIfExists(source)
    }


    [ProposedValueOfSymbol] (effect : ProposedValueOfEffect, activeEntry : QuarkI) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        const quark     = this.entries.get(source)

        const proposedValue = quark && !quark.isShadow() ? quark.getProposedValue(this) : undefined

        return proposedValue
    }


    [HasProposedValueSymbol] (effect : ProposedValueOfEffect, activeEntry : QuarkI) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        const quark     = this.entries.get(source)

        return quark ? quark.hasProposedValue() : false
    }


    [ProposedOrPreviousValueOfSymbol] (effect : ProposedValueOfEffect, activeEntry : QuarkI) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        return this.readDirty(source)
    }


    [UnsafeProposedOrPreviousValueOfSymbol] (effect : ProposedValueOfEffect, activeEntry : QuarkI) : any {
        return this.readDirty(effect.identifier)
    }


    [ProposedArgumentsOfSymbol] (effect : ProposedValueOfEffect, activeEntry : QuarkI) : any {
        const source    = effect.identifier

        this.addEdge(source, activeEntry, EdgeTypePast)

        const quark     = this.entries.get(source)

        return quark && !quark.isShadow() ? quark.proposedArguments : undefined
    }


    // this method is intentionally not used, but instead "manually" inlined - this improves benchmarks noticeably
    addEdge (identifierRead : Identifier, activeEntry : QuarkI, type : EdgeType) : QuarkI {
        const identifier    = activeEntry.identifier

        if (identifier.level < identifierRead.level) throw new Error('Identifier can not read from higher level identifier')

        let requestedEntry : Quark             = this.entries.get(identifierRead)

        // creating "shadowing" entry, to store the new edges
        if (!requestedEntry) {
            const previousEntry = this.baseRevision.getLatestEntryFor(identifierRead)

            if (!previousEntry) throwUnknownIdentifier(identifierRead)

            requestedEntry      = identifier.quarkClass.new({ identifier : identifierRead, origin : previousEntry.origin, previous : previousEntry, needToBuildProposedValue : identifier.proposedValueIsBuilt })

            this.entries.set(identifierRead, requestedEntry)

            if (!previousEntry.origin) requestedEntry.forceCalculation()
        }

        requestedEntry.getOutgoing().set(activeEntry, type)

        return requestedEntry
    }


    // this method is not decomposed into smaller ones intentionally, as that makes benchmarks worse
    // it seems that overhead of calling few more functions in such tight loop as this outweighs the optimization
    * calculateTransitionsStackGen (context : CalculationContext<any>, queue : LeveledStack<QuarkI>) : Generator<any, void, unknown> {
        const entries                       = this.entries
        const propagationStartDate          = this.propagationStartDate

        const enableProgressNotifications   = this.graph ? this.graph.enableProgressNotifications : false

        let counter : number                = 0

        const prevActiveStack               = this.activeStack

        while (queue.length) {

            const stack     = this.activeStack = queue.takeLowestLevel()

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

                // all entries in the stack must have entry already
                if (entry.edgesFlow == 0) {
                    entry.edgesFlow--

                    entries.delete(identifier)

                    const previousEntry = entry.previous

                    // // reduce garbage collection workload
                    entry.cleanup()

                    if (previousEntry && previousEntry.outgoing) {
                        for (const previousOutgoingEntry of previousEntry.outgoing.keys()) {
                            if (previousOutgoingEntry !== this.baseRevision.getLatestEntryFor(previousOutgoingEntry.identifier)) continue

                            const outgoingEntry     = entries.get(previousOutgoingEntry.identifier)

                            if (outgoingEntry) outgoingEntry.edgesFlow--
                        }
                    }

                    stack.pop()
                    continue
                }

                const quark : Quark   = entry.origin

                if (quark && quark.hasValue() || entry.edgesFlow < 0) {
                    entry.cleanup()

                    stack.pop()
                    continue
                }

                const startedAtEpoch    = entry.visitEpoch

                let iterationResult : IteratorResult<any>   = entry.isCalculationStarted() ? entry.iterationResult : entry.startCalculation(this.onEffectSync)

                do {
                    const value         = iterationResult.value === undefined ? null : iterationResult.value

                    if (entry.isCalculationCompleted()) {
                        if (entry.visitEpoch !== startedAtEpoch) {
                            stack.pop()
                            break
                        }

                        const quark         = entry.getQuark()

                        entry.setValue(value)

                        const previousEntry = entry.previous

                        // // reduce garbage collection workload
                        entry.cleanup()

                        let ignoreSelfDependency : boolean = false

                        const sameAsPrevious    = Boolean(previousEntry && previousEntry.hasValue() && identifier.equality(value, previousEntry.getValue()))

                        if (sameAsPrevious) entry.sameAsPrevious    = true

                        if (sameAsPrevious && previousEntry.outgoing) {
                            // if (/dispatcher/.test(previousEntry.identifier.name)) debugger

                            let currentEntry : Quark    = previousEntry

                            while (true) {
                                for (const [ previousOutgoingEntry, type ] of currentEntry.outgoing) {
                                    if (previousOutgoingEntry !== this.baseRevision.getLatestEntryFor(previousOutgoingEntry.identifier)) continue

                                    // // copy the "latest" outgoing edges from the previous entry - otherwise the dependency will be lost
                                    // entry.getOutgoing().set(previousOutgoingEntry, type)

                                    const outgoingEntry = entries.get(previousOutgoingEntry.identifier)

                                    if (outgoingEntry) outgoingEntry.edgesFlow--
                                }

                                if (currentEntry.isShadow())
                                    currentEntry   = currentEntry.previous
                                else
                                    break
                            }

                            entry.origin    = previousEntry.origin
                        }

                        if (quark.usedProposedOrCurrent) {
                            if (quark.proposedValue !== undefined) {
                                if (identifier.equality(value, quark.proposedValue)) ignoreSelfDependency = true
                            } else {
                                // ignore the uninitialized atoms (`proposedValue` === undefined && !previousEntry)
                                // which has been calculated to `null` - we don't consider this as a change
                                if (sameAsPrevious || (!previousEntry && value === null)) ignoreSelfDependency = true
                            }

                            if (!ignoreSelfDependency) this.candidate.selfDependentQuarks.add(quark.identifier)
                        }

                        stack.pop()
                        break
                    }
                    else if (value instanceof Identifier) {
                        if (entry.identifier.level < value.level) throw new Error('Identifier can not read from higher level identifier')

                        // should be just `this.addEdge` but inlined manually
                        let requestedEntry : Quark             = entries.get(value)

                        // creating "shadowing" entry, to store the new edges
                        if (!requestedEntry) {
                            const previousEntry = this.baseRevision.getLatestEntryFor(value)

                            if (!previousEntry) throwUnknownIdentifier(value)

                            requestedEntry      = identifier.quarkClass.new({ identifier : value, origin : previousEntry.origin, previous : previousEntry, needToBuildProposedValue : identifier.proposedValueIsBuilt })

                            entries.set(value, requestedEntry)

                            if (!previousEntry.origin) requestedEntry.forceCalculation()
                        }

                        requestedEntry.getOutgoing().set(entry, EdgeTypeNormal)
                        // EOF should be just `this.addEdge` but inlined manually

                        //----------------
                        let requestedQuark : Quark             = requestedEntry.origin

                        if (requestedQuark && requestedQuark.hasValue()) {
                            if (requestedQuark.value === TombStone) throwUnknownIdentifier(value)

                            iterationResult         = entry.continueCalculation(requestedQuark.value)
                        }
                        else if (requestedEntry.isShadow()) {
                            // shadow entry is shadowing a quark w/o value - it is still transitioning or lazy
                            // in both cases start new calculation
                            requestedEntry.origin   = requestedEntry
                            requestedEntry.forceCalculation()

                            stack.push(requestedEntry)
                            break
                        }
                        else {
                            if (!requestedEntry.isCalculationStarted()) {
                                stack.push(requestedEntry)
                                break
                            }
                            else {
                                // debugger
                                throw new Error("cycle")
                                // cycle - the requested quark has started calculation (means it was encountered in this loop before)
                                // but the calculation did not complete yet (even that requested quark is calculated before the current)
                                // yield GraphCycleDetectedEffect.new()
                            }
                        }
                    }
                    // else if (value instanceof Effect) {
                    //
                    //
                    //     stack.pop()
                    //     break
                    // }
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
                        if (entry.iterationResult)
                            iterationResult         = entry.continueCalculation(effectResult)
                        else
                            break
                    }

                } while (true)
            }
        }

        this.activeStack    = prevActiveStack
    }


    // // THIS METHOD HAS TO BE KEPT SYNCED WITH THE `calculateTransitionsStackGen` !!!
    calculateTransitionsStackSync (context : CalculationContext<any>, queue : LeveledStack<QuarkI>) {
        const entries                       = this.entries
        const prevActiveStack               = this.activeStack

        while (queue.length) {

            const stack     = this.activeStack = queue.takeLowestLevel()

            while (stack.length) {
                const entry             = stack[ stack.length - 1 ]
                const identifier        = entry.identifier

                // all entries in the stack must have entry already
                if (entry.edgesFlow == 0) {
                    entry.edgesFlow--

                    entries.delete(identifier)

                    const previousEntry = entry.previous

                    // // reduce garbage collection workload
                    entry.cleanup()

                    if (previousEntry && previousEntry.outgoing) {
                        for (const previousOutgoingEntry of previousEntry.outgoing.keys()) {
                            if (previousOutgoingEntry !== this.baseRevision.getLatestEntryFor(previousOutgoingEntry.identifier)) continue

                            const outgoingEntry     = entries.get(previousOutgoingEntry.identifier)

                            if (outgoingEntry) outgoingEntry.edgesFlow--
                        }
                    }

                    stack.pop()
                    continue
                }

                const quark : Quark   = entry.origin

                if (quark && quark.hasValue() || entry.edgesFlow < 0) {
                    entry.cleanup()

                    stack.pop()
                    continue
                }

                const startedAtEpoch    = entry.visitEpoch

                let iterationResult : IteratorResult<any>   = entry.isCalculationStarted() ? entry.iterationResult : entry.startCalculation(this.onEffectSync)

                do {
                    const value         = iterationResult.value === undefined ? null : iterationResult.value

                    if (entry.isCalculationCompleted()) {
                        if (entry.visitEpoch !== startedAtEpoch) {
                            stack.pop()
                            break
                        }

                        const quark         = entry.getQuark()

                        entry.setValue(value)

                        const previousEntry = entry.previous

                        // // reduce garbage collection workload
                        entry.cleanup()

                        let ignoreSelfDependency : boolean = false

                        const sameAsPrevious    = Boolean(previousEntry && previousEntry.hasValue() && identifier.equality(value, previousEntry.getValue()))

                        if (sameAsPrevious) entry.sameAsPrevious    = true

                        if (sameAsPrevious && previousEntry.outgoing) {
                            // if (/dispatcher/.test(previousEntry.identifier.name)) debugger

                            let currentEntry : Quark    = previousEntry

                            while (true) {
                                for (const [ previousOutgoingEntry, type ] of currentEntry.outgoing) {
                                    if (previousOutgoingEntry !== this.baseRevision.getLatestEntryFor(previousOutgoingEntry.identifier)) continue

                                    // // copy the "latest" outgoing edges from the previous entry - otherwise the dependency will be lost
                                    // entry.getOutgoing().set(previousOutgoingEntry, type)

                                    const outgoingEntry = entries.get(previousOutgoingEntry.identifier)

                                    if (outgoingEntry) outgoingEntry.edgesFlow--
                                }

                                if (currentEntry.isShadow())
                                    currentEntry   = currentEntry.previous
                                else
                                    break
                            }

                            entry.origin    = previousEntry.origin
                        }

                        if (quark.usedProposedOrCurrent) {
                            if (quark.proposedValue !== undefined) {
                                if (identifier.equality(value, quark.proposedValue)) ignoreSelfDependency = true
                            } else {
                                // ignore the uninitialized atoms (`proposedValue` === undefined && !previousEntry)
                                // which has been calculated to `null` - we don't consider this as a change
                                if (sameAsPrevious || (!previousEntry && value === null)) ignoreSelfDependency = true
                            }

                            if (!ignoreSelfDependency) this.candidate.selfDependentQuarks.add(quark.identifier)
                        }

                        stack.pop()
                        break
                    }
                    else if (value instanceof Identifier) {
                        if (entry.identifier.level < value.level) throw new Error('Identifier can not read from higher level identifier')

                        // should be just `this.addEdge` but inlined manually
                        let requestedEntry : Quark             = entries.get(value)

                        // creating "shadowing" entry, to store the new edges
                        if (!requestedEntry) {
                            const previousEntry = this.baseRevision.getLatestEntryFor(value)

                            if (!previousEntry) throwUnknownIdentifier(value)

                            requestedEntry      = identifier.quarkClass.new({ identifier : value, origin : previousEntry.origin, previous : previousEntry, needToBuildProposedValue : identifier.proposedValueIsBuilt })

                            entries.set(value, requestedEntry)

                            if (!previousEntry.origin) requestedEntry.forceCalculation()
                        }

                        requestedEntry.getOutgoing().set(entry, EdgeTypeNormal)
                        // EOF should be just `this.addEdge` but inlined manually

                        //----------------
                        let requestedQuark : Quark             = requestedEntry.origin

                        if (requestedQuark && requestedQuark.hasValue()) {
                            if (requestedQuark.value === TombStone) throwUnknownIdentifier(value)

                            iterationResult         = entry.continueCalculation(requestedQuark.value)
                        }
                        else if (requestedEntry.isShadow()) {
                            // shadow entry is shadowing a quark w/o value - it is still transitioning or lazy
                            // in both cases start new calculation
                            requestedEntry.origin   = requestedEntry
                            requestedEntry.forceCalculation()

                            stack.push(requestedEntry)
                            break
                        }
                        else {
                            if (!requestedEntry.isCalculationStarted()) {
                                stack.push(requestedEntry)
                                break
                            }
                            else {
                                // debugger
                                throw new Error("cycle")
                                // cycle - the requested quark has started calculation (means it was encountered in this loop before)
                                // but the calculation did not complete yet (even that requested quark is calculated before the current)
                                // yield GraphCycleDetectedEffect.new()
                            }
                        }
                    }
                    // else if (value instanceof Effect) {
                    //
                    //
                    //     stack.pop()
                    //     break
                    // }
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

                        // the calculation can be interrupted (`cleanupCalculation`) as a result of the effect (WriteEffect)
                        // in such case we can not continue calculation and just exit the inner loop
                        if (entry.iterationResult)
                            iterationResult         = entry.continueCalculation(effectResult)
                        else
                            break
                    }

                } while (true)
            }
        }

        this.activeStack    = prevActiveStack
    }
}

export type Transaction = Mixin<typeof Transaction>

export interface TransactionI extends Mixin<typeof Transaction> {}

export class MinimalTransaction extends Transaction(Base) {}
