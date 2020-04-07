import { ChronoGraph } from "../src/chrono/Graph.js";
import { CytoscapeWrapper } from "../src/visualization/Cytoscape.js";


const graph       = ChronoGraph.new()

const i1        = graph.variableNamed('i1', 0)
const i2        = graph.variableNamed('i2', 10)

const c1        = graph.identifierNamed('c1', function* () {
    return (yield i1) + (yield i2)
})

const c2        = graph.identifierNamed('c2', function* () {
    return (yield i1) + (yield c1)
})

const c3        = graph.identifierNamed('c3', function* () {
    return (yield c1)
})

const c4        = graph.identifierNamed('c4', function* () {
    return (yield c3)
})

const c5        = graph.identifierNamed('c5', function* () {
    return (yield c3)
})

const c6        = graph.identifierNamed('c6', function* () {
    return (yield c5) + (yield i2)
})

graph.commit()


window.addEventListener('load', () => {
    const wrapper = CytoscapeWrapper.new({ graph });
    wrapper.renderTo(document.getElementById('graph'));
});
