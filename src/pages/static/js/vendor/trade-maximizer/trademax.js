/*
   TradeMaximizer javascript version 0.1
   Translated from Chris Okasaki's Java version by Jeff Michaud.
   November 4th, 2018
*/

import './javarandom.js'
import './md5.js'

// test input
var testinput = [
  "(user1) item1 : item2",
  "(user2) item2 : item1"
];

//I could not get this style JS enums to work
//const VertexType { RECEIVER:1, SENDER:2 }
//const EdgeStatus { UNKNOWN:1, REQUIRED:2, OPTIONAL:3, FORBIDDEN:4 }
//const PriorityType { NO_PRIORITIES:1, LINEAR_PRIORITIES:2, TRIANGLE_PRIORITIES:3,
//                     SQUARE_PRIORITIES:4, SCALED_PRIORITIES:5, EXPLICIT_PRIORITIES:6 } }

const RECEIVER = 1;
const SENDER = 2;
const UNKNOWN = 3;
const REQUIRED = 4;
const OPTIONAL = 5;
const FORBIDDEN = 6;

const INFINITY  = 10000000000000000; // 10^16 from class Graph
//const INFINITY2 = 100000000000000;   // 10^14 from class TradeMaximizer
const UNIT = 1;

const version = "Version 0.1";

const NO_PRIORITIES = 0;
const LINEAR_PRIORITIES = 1;
const TRIANGLE_PRIORITIES = 2;
const SQUARE_PRIORITIES = 3;
const SCALED_PRIORITIES = 4; // no longer supported!!
const EXPLICIT_PRIORITIES = 5;

class MetricSumSquares {
  constructor() {
    this.name = "MetricSumSquares";
    this.sumOfSquares = 0;
    this.counts = null;
  }

  calculate(cycles) {
    this.sumOfSquares = 0;
    this.counts = [];
    for( let cycle of cycles ) {
      this.sumOfSquares += cycle.length * cycle.length;
      this.counts.push(cycle.length);
    }
    this.counts = this.counts.sort(function(a, b){return b - a});
    return this.sumOfSquares;
  }

  toString() {
    let str = "[ " + this.sumOfSquares + " :";

    for( let c of this.counts )
      str += " " + c;

    return str + " ]";
  }
} // class MetricSumSquares 

class MetricUsersTrading {
  constructor() {
    this.name = "MetricUsersTrading";
    this.count = 0;
  }

  calculate(cycles) {
    let users = new Array();

    for( let cycle of cycles )
      for( let vert of cycle )
        users[vert.user] = 1;

    this.count = Object.keys(users).length;

    return -this.count;
  }

  toString() {
    return "[ users trading = " + this.count + " ]";
  }
} // class MetricUsersTrading

var metricmap = [];
metricmap["CHAIN-SIZES-SOS"] = new MetricSumSquares();
metricmap["USERS-TRADING"]   = new MetricUsersTrading();

class Entry {
  constructor(vertex, cost, heap) {
    this.vertex = vertex;
    this.cost = cost;
    this.heap = heap;
    this.child = null;
    this.sibling = null;
    this.prev = null;
    this.used = false;
  }

  decreaseCost(toCost) {
    this.cost = toCost;
    if( this == this.heap.root || this.cost >= this.prev.cost )
      return;
    if( this == this.prev.child )
      this.prev.child = this.sibling;
    else
      this.prev.sibling = this.sibling;
    if( this.sibling != null )
      this.sibling.prev = this.prev;
    this.prev = null;

    this.heap.root = this.heap.merge(this, this.heap.root);
  }
}

class Heap {
  constructor() {
    this.root = null;
  }

  isEmpty() {
    return this.root == null;
  }

  merge(a, b) {
    if( b.cost < a.cost ) {
      let tmp = a;
      a = b;
      b = tmp;
    }
    b.prev = a;
    b.sibling = a.child;
    if( b.sibling != null )
      b.sibling.prev = b;
    a.child = b;
    return a;
  }

  extractMin() {
    let minEntry = this.root;

    this.root.used = true;

    let list = this.root.child;

    if( list != null ) {
      while( list.sibling != null ) {
        let nextList = null;
        while( list != null && list.sibling != null ) {
          let a = list;
          let b = a.sibling;

          list = b.sibling;

          a.sibling = null;
          b.sibling = null;
          a = this.merge(a,b);
          a.sibling = nextList;
          nextList = a;
        }
        if( list == null )
          list = nextList;
        else
          list.sibling = nextList;
      }
      list.prev = null;
    }
    this.root = list;
    return minEntry;
  }

  insert(vertex, cost) {
    let entry = new Entry(vertex, cost, this);
    this.root = this.root == null ? entry : this.merge(entry, this.root);
    return entry;
  }
} // class Heap

class Vertex {
  constructor(name, user, isDummy, type) {
    this.name = name;
    this.user = user;
    this.isDummy = isDummy;
    this.type = type;

    this.edgeMap = [];
    this.edgeList = [];
    this.edges = null;

    this.minimumInCost = Number.MAX_SAFE_INTEGER;
    this.twin = null;
    this.mark = 0;
    this.match = null;
    this.matchCost = 0;
    this.from = null;
    this.price = 0;
    this.heapEntry = null;
    this.component = 0;
    this.used = false;

    this.savedMatch = null;
    this.savedMatchCost = 0;

    this.dirty = true;
  }

  toString() {
    return this.name + this.user + "/" + this.type;
  }
}

class Edge {
  constructor(receiver, sender, cost) {
    this.receiver = receiver;
    this.sender = sender;
    this.cost = cost;
    this.status = UNKNOWN;
  }

  toString() {
    return this.receiver.toString() + "-from-" + this.sender.toString();
  }
}

class Graph {
  constructor(tm) {
    this.tm = tm;
    this.hasBeenFullyShrunk = false;
    this.sinkFrom = null;
    this.sinkCost = null;
    this.receiverList = new Array();
    this.senderList = new Array();
    this.receivers = [];
    this.senders = [];
    this.orphans = [];
    this.frozen = false;
    this.nameMap = new Array();
    this.timestamp = 0;
    this.component = 0;
    this.finished = [];
    this.seed = null;
    this.random = null;
    this.randomSequence = [];
this.rngcount = 0;
  }

  getVertex(name) {
    return this.nameMap[name];
  }

  addVertex(name, user, isDummy) {
    let receiver = new Vertex(name, user, isDummy, RECEIVER);

    this.receiverList.push(receiver);
    this.nameMap[name] = receiver;

    let sender = new Vertex(name, user, isDummy, SENDER);
    this.senderList.push(sender);
    receiver.twin = sender;
    sender.twin = receiver;

    return receiver;
  }

  addEdge(receiver, sender, cost) {
    let edge = new Edge(receiver,sender,cost);
    receiver.edgeMap[sender] = edge;
    sender.edgeMap[receiver] = edge;
    receiver.edgeList.push(edge);
    sender.edgeList.push(edge);
    return edge;
  }

  getEdge(receiver, sender) {
    return receiver.edgeMap[sender];
  }

  freeze() {
    this.receivers = this.receiverList;
    this.senders = this.senderList;

    this.receiverList = this.senderList = null;

    for( let v of this.receivers )
      v.edges = v.edgeList;
    for( let v of this.senders )
      v.edges = v.edgeList;

    this.frozen = true;
  }

  advanceTimestamp() {
    this.timestamp++;
  }

  visitReceivers(receiver) {
    receiver.mark = this.timestamp;
    for( let edge of receiver.edges ) {
      let v = edge.sender.twin;
      if( v.mark != this.timestamp )
        this.visitReceivers(v);
    }
    this.finished.push(receiver.twin);
  }

  visitSenders(sender) {
    sender.mark = this.timestamp;
    for( let edge of sender.edges ) {
      let v = edge.receiver.twin;
      if( v.mark != this.timestamp )
        this.visitSenders(v);
    }
    sender.component = this.component;
    sender.twin.component = this.component;
  }

  removeBadEdges(v) {
    let newedges = [];

    for( let edge of v.edges ) {
      if( edge.receiver.component == edge.sender.component )
	newedges.push(edge);
      else
        edge.sender.dirty = true;
    }
    v.edges = newedges;
  }

  removeImpossibleEdgesAndOrphans() {
    this.advanceTimestamp();
    this.finished = new Array();

    for( let v of this.receivers )
      if( v.mark != this.timestamp )
        this.visitReceivers(v);

    this.finished = this.finished.reverse();

    for( let v of this.finished ) {
      if( v.mark != this.timestamp ) {
        this.component++;
        this.visitSenders(v);
      }
    }

    for( let v of this.receivers ) this.removeBadEdges(v);
    for( let v of this.senders )   this.removeBadEdges(v);

    this.removeOrphans();
  }

  removeOrphans() {
    let newreceivers = [];

    for( let v of this.receivers ) {
      if( v.edges.length > 1 || v.edges[0].sender != v.twin )
        newreceivers.push(v);
      else
        this.orphans.push(v);
    }

    if( newreceivers.length == this.receivers.length )
      return;

    this.receivers = newreceivers;

    let newsenders = [];

    for( let v of this.senders ) {
      if( v.edges.length > 1 || v.edges[0].receiver != v.twin )
        newsenders.push(v);
    }
    this.senders = newsenders;
  }

  dijkstra() {
    this.sinkFrom = null;
    this.sinkCost = Number.MAX_SAFE_INTEGER;

    let heap = new Heap();

    for( let v of this.senders ) {
      v.from = null;
      v.heapEntry = heap.insert(v, INFINITY);
    }
    for( let v of this.receivers ) {
      v.from = null;
      let cost = v.match == null ? 0 : INFINITY;
      v.heapEntry = heap.insert(v, cost);
    }

    while( ! heap.isEmpty() ) {
      let minEntry = heap.extractMin();
      let vertex = minEntry.vertex;
      let cost = minEntry.cost;

      if( cost == INFINITY )
        break;

      if( vertex.type == RECEIVER ) {
        for( let e of vertex.edges ) {
          let other = e.sender;
          if( other == vertex.match )
            continue;

          let c = vertex.price + e.cost - other.price;
          if( cost + c < other.heapEntry.cost ) {
            other.heapEntry.decreaseCost(cost + c);
            other.from = vertex;
          }
        }
      }
      else if( vertex.match == null ) {
        if( cost < this.sinkCost ) {
          this.sinkFrom = vertex;
          this.sinkCost = cost;
        }
      }
      else {
        let other = vertex.match;
        let c = vertex.price - other.matchCost - other.price;
        if( cost + c < other.heapEntry.cost ) {
          other.heapEntry.decreaseCost(cost + c);
          other.from = vertex;
        }
      }
    }
  }

  findBestMatches() {
    if( this.hasBeenFullyShrunk ) {
      this.findUnweightedMatches();
      return;
    }

    for( let v of this.receivers ) {
      v.match = null;
      v.price = 0;
    }

    for( let v of this.senders ) {
      v.match = null;
      if( v.dirty ) {
        v.minimumInCost = Number.MAX_SAFE_INTEGER;
        for( let edge of v.edges )
          v.minimumInCost = Math.min(edge.cost, v.minimumInCost);
        v.dirty = false;
      }
      v.price = v.minimumInCost;
    }

    for( let round = 0 ; round < this.receivers.length ; round++ ) {
      this.dijkstra();

      let sender = this.sinkFrom;
      while( sender != null ) {
        let receiver = sender.from;

        if( sender.match != null )
          sender.match.match = null;
        if( receiver.match != null )
          receiver.match.match = null;

        sender.match = receiver;
        receiver.match = sender;

        for( let e of receiver.edges )
          if( e.sender == sender ) {
            receiver.matchCost = e.cost;
            break;
          }

        sender = receiver.from;
      }

      for( let v of this.receivers )
        v.price += v.heapEntry.cost;
      for( let v of this.senders )
        v.price += v.heapEntry.cost;
    }
  }

  findCycles() {
    this.findBestMatches();
    this.elideDummies();
    this.advanceTimestamp();

    let cycles = new Array();

    for( let vertex of this.receivers ) {
      if( vertex.mark == this.timestamp || vertex.match == vertex.twin )
        continue;

      let cycle = new Array();
      let v = vertex;
      while( v.mark != this.timestamp ) {
        v.mark = this.timestamp;
        cycle.push(v);
        v = v.match.twin;
      }
      cycles.push(cycle);
    }
    return cycles;
  }

  randomsneeded() {
    let count = this.receivers.length;
    for( let v of this.receivers )
      count += v.edges.length;
    return count;
  }

  setSeed(seed) {
    this.seed = seed;
    this.random = new JavaRandom(seed);
  }

  nextInt(bound) {
    ++this.rngcount;
    let r = this.random.nextInt(bound);
    //this.randomSequence.push(bound + "/" + r);
    return r;
  }

  shuffleit(a) {
    for( let i = a.length ; i > 1 ; i-- ) {
      let j = this.nextInt(i);
      let tmp = a[j];
      a[j] = a[i-1];
      a[i-1] = tmp;
    }
  }

  shuffle() {
    this.shuffleit(this.receivers);
    for( let v of this.receivers )
      this.shuffleit(v.edges);
  }

  elideDummies() {
    for( let v of this.receivers ) {
      while( v.match.isDummy && v.match != v.twin ) {
        let dummySender = v.match;
        let nextSender = dummySender.twin.match;
        v.match = nextSender;
        nextSender.match = v;
        dummySender.match = dummySender.twin;
        dummySender.twin.match = dummySender;
      }
    }
  }

  saveMatches() {
    for( let v of this.receivers ) {
      v.savedMatch = v.match;
      v.savedMatchCost = v.matchCost;
    }
    for( let v of this.senders )
      v.savedMatch = v.match;
  }

  restoreMatches() {
    for( let v of this.receivers ) {
      v.match = v.savedMatch;
      v.matchCost = v.savedMatchCost;
    }
    for( let v of this.senders )
      v.match = v.savedMatch;
  }

  shrink(level, verbose) {
    this.reportStats("Original", verbose);

    this.removeImpossibleEdgesAndOrphans();
    this.reportStats("Shrink 0 (SCC)", verbose);
    if( level == 0 )
      return;

    let startTime = Date.now();

    let factor = this.receivers.length + 1;

    this.scaleUpEdgeCosts(factor);

    this.findRequiredEdgesAndShrink(verbose);
    this.removeImpossibleEdgesAndOrphans();
    this.reportStats("Shrink 1 (SCC)", verbose);
    if( verbose )
      this.tm.outputln("Shrink 1 time = " + (Date.now() - startTime) + "ms");

    if( level > 1 ) {
      this.findForbiddenEdgesAndShrink(verbose);
      this.removeImpossibleEdgesAndOrphans();
      this.reportStats("Shrink 2 (SCC)", verbose);
      if( verbose )
        this.tm.outputln("Shrink 2 time = " + (Date.now() - startTime) + "ms");
      this.hasBeenFullyShrunk = true;
    }

    this.scaleDownEdgeCosts(factor);
  }

  scaleUpEdgeCosts(factor) {
    for( let v of this.senders ) {
      v.dirty = true;
      for( let e of v.edges )
        e.cost *= factor;
    }
  }

  scaleDownEdgeCosts(factor) {
    for( let v of this.senders ) {
      v.dirty = true;
      for( let e of v.edges )
        e.cost = Math.floor(e.cost/factor);
    }
  }

  findRequiredEdgesAndShrink(verbose) {
    let numRequired = this.receivers.length;
    let totalCost = 0;
    let requiredEdges = new Array(numRequired);
    let run = 1;

    if( ! verbose )
      this.tm.output("Shrink (level 1) ");

    this.findBestMatches();

    //let tradeCount = 0;

    for( let i = 0 ; i < this.receivers.length ; i++ ) {
      let v = this.receivers[i];
      let e = v.edgeMap[v.match];
      //if( v.match != v.twin )
      //  tradeCount++;
      totalCost += e.cost;
      requiredEdges[i] = e;
      e.status = REQUIRED;
      e.cost++;
      if( e.cost == e.sender.minimumInCost+1 )
        e.sender.dirty = true;
    }

    this.reportStatsOrDot("Shrink 1."+run, verbose);

    for( run = 2 ; numRequired > 0 ; run++ ) {
      this.findBestMatches();
      let currentCost = 0;
      let edgeSet = [];
      for( let v of this.receivers ) {
        let e = v.edgeMap[v.match];
        edgeSet.push(e);
        currentCost += e.cost;
        if( e.status != REQUIRED )
          e.status = OPTIONAL;
      }
      if( currentCost == totalCost + numRequired ) {
        this.reportStatsOrDot("Shrink 1."+run, verbose);
        break;
      }
      let count = 0;
      for( let i = 0 ; i < numRequired ; i++ ) {
        let e = requiredEdges[i];
        if( edgeSet.includes(e) )
          requiredEdges[count++] = e;
        else {
          e.status = OPTIONAL;
          e.cost--;
          if( e.cost == e.sender.minimumInCost-1 )
            e.sender.dirty = true;
        }
      }
      numRequired = count;
      this.reportStatsOrDot("Shrink 1."+run, verbose);
    }

    for( let i = 0 ; i < numRequired ; i++ ) {
      let e = requiredEdges[i];
      this.markEdgesForbiddenIfNotRequired(e.receiver);
      this.markEdgesForbiddenIfNotRequired(e.sender);
    }

    for( let v of this.receivers )
      this.removeEdges(v, FORBIDDEN);
    for( let v of this.senders )
      this.removeEdges(v, FORBIDDEN);

/*
    for( let i = 0 ; i < numRequired ; i++ ) {
      let e = requiredEdges[i];
      assert e.receiver.edges.length == 1;
      assert e.sender.edges.length == 1;
    }
*/

    if( verbose )
      this.reportStats("Shrink 1 complete", verbose);
    else
      this.tm.outputln("");
  }

  findForbiddenEdgesAndShrink(verbose) {
    let V = this.receivers.length;
    let run = 1;

    for( let v of this.receivers )
      for( let e of v.edges )
        if( e.status == OPTIONAL) {
          e.cost++;
          if( e.cost == e.sender.minimumInCost+1 )
            e.sender.dirty = true;
        }

    if( ! verbose )
      this.tm.output("Shrink (level 2) ");

    for( let newEdges = 999 ; newEdges > 0 ; run++ ) {
      this.findBestMatches();
      newEdges = 0;
      let edgeSet = new Array(V);
      for( let v of this.receivers ) {
        let e = v.edgeMap[v.match];
        if( e.status == UNKNOWN ) {
          e.status = OPTIONAL;
          e.cost++;
          if( e.cost == e.sender.minimumInCost+1 )
            e.sender.dirty = true;
          newEdges++;
        }
      }
      this.reportStatsOrDot("Shrink 2."+run, verbose);
    }

    for( let v of this.receivers )
      this.removeEdges(v, UNKNOWN);
    for( let v of this.senders )
      this.removeEdges(v, UNKNOWN);

    if( verbose )
      this.reportStats("Shrink level 2 complete", verbose);
    else
      this.tm.outputln("");
  }

  markEdgesForbiddenIfNotRequired(v) {
    for( let e of v.edges )
      if( e.status != REQUIRED )
        e.status = FORBIDDEN;
  }

  removeEdges(v, statusToRemove) {
    let newedges = [];

    for( let e of v.edges )
      if( e.status == statusToRemove )
        e.sender.dirty = true;
      else
        newedges.push(e);

    v.edges = newedges;
  }

  reportStatsOrDot(name, verbose) {
    if( verbose )
      this.reportStats(name, verbose);
    else
      this.tm.output(".");
  }

  reportStats(name, verbose) {
    if( ! verbose )
      return;

    let histogram = [];
    let edgeCount = 0;

    histogram[REQUIRED] = 0;
    histogram[OPTIONAL] = 0;
    histogram[UNKNOWN] = 0;

    for( let v of this.receivers )
      for( let e of v.edges ) {
        histogram[e.status]++;
        edgeCount++;
      }

    this.tm.outputln(name +
      ": V=" + this.receivers.length +
      " E=" + edgeCount +
      " REQUIRED=" + histogram[REQUIRED] +
      " OPTIONAL=" + histogram[OPTIONAL] +
      " UNKNOWN="  + histogram[UNKNOWN]);
  }

  findUnweightedMatches() {
    for( let v of this.receivers )
      v.match = null;
    for( let v of this.senders ) {
      v.match = null;
      v.price = 0; 
    }

    let n = this.receivers.length;
    let receiverStack = new Array(n);
    let indexStack = new Array(n);
    let senderStack = new Array(n);
    let time = 0;

    for( let v of this.receivers ) {
      time++;

      let pos = 0;
      receiverStack[pos] = v;
      indexStack[pos] = 0;
      v.price = time;

      while( true ) {
        let receiver = receiverStack[pos];
        let i = indexStack[pos]++;
        if( i == receiver.edges.length )
          pos--;
        else {
          let sender = receiver.edges[i].sender;
          if( sender.price == time )
            continue;

          senderStack[pos] = sender;
          if( sender.match == null )
            break;

          sender.price = time; // mark as visited
          receiverStack[++pos] = sender.match;
          indexStack[pos] = 0;
        }
      }

      for( let i = 0 ; i <= pos ; i++ ) {
        let receiver = receiverStack[i];
        let sender = senderStack[i];
        receiver.match = sender;
        sender.match = receiver;
      }
    }

    for( let v of this.receivers ) {
      let matchCost = v.edgeMap[v.match].cost;
      v.matchCost = v.match.matchCost = matchCost;
    }
  }
}

class TradeMaximizer {
  constructor() {
    this.iterations = 1;
    this.priorityScheme = NO_PRIORITIES;
    this.smallStep = 1;
    this.bigStep = 9;
    this.nonTradeCost = 1000000000; // 1 billion
    this.shrinkLevel = 0;
    this.shrinkVerbose = false;
    this.officialNames = null;
    this.usedNames = new Array();
    this.graph = null;
    this.errors = new Array();
    this.options = new Array();
    this.ITEMS = 0;
    this.DUMMY_ITEMS = 0;
    this.width = 1;

    this.caseSensitive = false;
    this.requireColons = false;
    this.requireUsernames = false;
    this.showErrors = true;
    this.showRepeats = true;
    this.showLoops = true;
    this.showSummary = true;
    this.showNonTrades = true;
    this.showStats = true;
    this.showMissing = false;
    this.sortByItem = false;
    this.allowDummies = false;
    this.showElapsedTime = false;
    this.showWants = false;
    this.verbose = false;

    this.metric = [ metricmap["CHAIN-SIZES-SOS"] ];

    this.infunc = null;
    this.outfunc = null;
    this.progress = null;
    this.fatal = null;

this.inputindex = 0;
this.outputstr = "";
  }

  readLine() {
    return this.infunc();
//if( this.inputindex >= testinput.length ) return null;
//return testinput[this.inputindex++];
  }

  output(s) {
    this.outfunc(s, false);
//this.outputstr += s;
  }

  outputln(s) {
    this.outfunc(s, true);
//this.outputstr += s + "\n";
  }

  fatalError(s) {
    if( this.fatal ) {
      this.fatal(s);
    }
    else {
      //outputln(s);
      alert(s);
    }
  }

  run(input,out,progress,fatal) {
    this.infunc = input;
    this.outfunc = out;
    this.progress = progress;
    this.fatal = fatal;

    this.outputln("TradeMaximizer Javascript " + version);
    this.outputln("Run Date: " + (new Date()).toTimeString());

    this.graph = new Graph(this);

    let wantLists = this.readWantLists();
    if( wantLists == null )
      return;

    if( this.options.length > 0 ) {
      this.output("Options:");
      for( let option of this.options )
        this.output(" " + option);
      this.outputln("");
    }

    if( this.priorityScheme != NO_PRIORITIES && (this.metric.length > 1 || this.metric[0].name != "MetricSumSquares") )
      this.outputln("Warning: using priorities with the non-default metric is normally worthless");

    let hash = md5.create();
    for( let wset of wantLists ) {
      for( let w of wset ) {
        hash.update(' ');
        hash.update(w);
      }
      hash.update("\n");
    }
    this.outputln("Input Checksum: " + hash.hex());

    this.buildGraph(wantLists);

    if( this.showErrors && this.errors.length > 0 ) {
      this.outputln("ERRORS:");
      for( let error of this.errors.sort() )
        this.outputln(error);
      this.outputln("");
    }

    let startTime = Date.now();

    if( this.iterations > 1 && this.progress != null )
      this.progress(0, this.iterations, "", "");

    this.graph.shrink(this.shrinkLevel, this.shrinkVerbose);

/*
this.outputln("Dump of graph, count="+this.graph.receivers.length);
for( let i = 0 ; i < this.graph.receivers.length ; i++ ) {
  this.outputln(i+": "+this.graph.receivers[i].name);
}
*/

/*
    if( this.iterations > 1 )
      this.outputln("Number of random numbers needed: " + this.graph.randomsneeded() * this.iterations);
*/

    let bestCycles = this.graph.findCycles();

    let bestMetric = [];
    let bestMetricStr = "";
    for( let m of this.metric ) {
      bestMetric.push(m.calculate(bestCycles));
      bestMetricStr += m.toString();
    }

    let tradeCount = 0;

    for( let cycle of bestCycles )
      tradeCount += cycle.length;

    if( this.iterations > 1 && this.progress != null )
      this.progress(1, this.iterations, bestMetricStr, tradeCount);

    this.outputln(bestMetricStr + " (iteration 0)");

    if( this.iterations > 1 ) {
      this.graph.saveMatches();
      for( let i = 1 ; i <= this.iterations-1 ; i++ ) {
        if( this.progress != null )
          this.progress(i, this.iterations, bestMetricStr, tradeCount);

        this.graph.shuffle();

/*
this.outputln("Dump of graph, count="+this.graph.receivers.length + ", iteration="+i);
for( let i = 0 ; i < this.graph.receivers.length ; i++ ) {
  this.outputln(i+": "+this.graph.receivers[i].name);
}
*/

        let cycles = this.graph.findCycles();

        //let metric = this.metric[0].calculate(cycles);

        let foundBetter = false;
        let newmetrics = [];
        let newmetricsStr = "";
        for( let i = 0 ; i < this.metric.length ; i++ ) {
          let value = this.metric[i].calculate(cycles);
          newmetrics.push(value);
          newmetricsStr += this.metric[i].toString();
          if( value < bestMetric[i] ) {
            // we found better results
            for( let j = i+1 ; j < this.metric.length ; j++ ) {
              newmetrics.push(this.metric[j].calculate(cycles));
              newmetricsStr += this.metric[j].toString();
            }
            foundBetter = true;
            break;
          }
          else if( value > bestMetric[i] )
            break;
          // else if they are equal of course go to next metric
        }

        if( foundBetter ) {
          bestCycles = cycles;
          this.graph.saveMatches();

          bestMetric = newmetrics;
          bestMetricStr = newmetricsStr;

          this.outputln(bestMetricStr + " (iteration " + i + ")");
          tradeCount = 0;
          for( let cycle of bestCycles )
            tradeCount += cycle.length;
        }
        else if( this.verbose )
          this.outputln("# " + newmetricsStr + " (iteration " + i + ")");
      }
      this.outputln("Completed " + this.iterations + " iterations.");
      this.outputln("");
      this.graph.restoreMatches();
    }
    let stopTime = Date.now();
    this.displayMatches(bestCycles);

    if (this.showElapsedTime)
      this.outputln("Elapsed time = " + (stopTime-startTime) + "ms");
  }

  sumOfSquares(cycles) {
    let sum = 0;
    for( let cycle of cycles )
      sum += cycle.length * cycle.length;
    return sum;
  }

  readWantLists() {
    let bigStepFlag = false, smallStepFlag = false;
    let readingOfficialNames = false;
    let wantLists = new Array();

    for( let lineNumber = 1 ; ; lineNumber++ ) {
      let line = this.readLine();
      if( line == null )
        return wantLists;
      line = line.trim();

      if( line.length == 0 )
        continue;
      if( line.match("#!.*") ) {
        if( wantLists.length > 0 )
          this.fatalError("Options (#!...) cannot be declared after first real want list", lineNumber);
        if( this.officialNames != null )
          this.fatalError("Options (#!...) cannot be declared after official names", lineNumber);

        let optionslist = line.toUpperCase().substring(2).trim().split(/\s+/);
        for( let option of optionslist ) {
            if (option == "CASE-SENSITIVE" )
              this.caseSensitive = true;
            else if (option == "REQUIRE-COLONS" )
              this.requireColons = true;
            else if (option == "REQUIRE-USERNAMES" )
              this.requireUsernames = true;
            else if (option == "HIDE-ERRORS" )
              this.showErrors = false;
            else if (option == "HIDE-REPEATS" )
              this.showRepeats = false;
            else if (option == "HIDE-LOOPS" )
              this.showLoops = false;
            else if (option == "HIDE-SUMMARY" )
              this.showSummary = false;
            else if (option == "HIDE-NONTRADES" )
              this.showNonTrades = false;
            else if (option == "HIDE-STATS" )
              this.showStats = false;
            else if (option == "SHOW-MISSING" )
              this.showMissing = true;
            else if (option == "SORT-BY-ITEM" )
              this.sortByItem = true;
            else if (option == "ALLOW-DUMMIES" )
              this.allowDummies = true;
            else if (option == "SHOW-ELAPSED-TIME" )
              this.showElapsedTime = true;
            else if (option == "LINEAR-PRIORITIES" )
              this.priorityScheme = LINEAR_PRIORITIES;
            else if (option == "TRIANGLE-PRIORITIES" )
              this.priorityScheme = TRIANGLE_PRIORITIES;
            else if (option == "SQUARE-PRIORITIES" )
              this.priorityScheme = SQUARE_PRIORITIES;
            else if (option == "SCALED-PRIORITIES" ) {
              this.priorityScheme = SCALED_PRIORITIES;
              //this.fatalError("SCALED-PRIORITIES no longer supported!",lineNumber);
            }
            else if (option == "EXPLICIT-PRIORITIES" )
              this.priorityScheme = EXPLICIT_PRIORITIES;
            else if (option.startsWith("SMALL-STEP=")) {
              let num = option.substring(11);
              if (!num.match(/\d+/))
                this.fatalError("SMALL-STEP argument must be a non-negative integer",lineNumber);
              this.smallStep = Number(num);
              smallStepFlag = true;
            }
            else if (option.startsWith("BIG-STEP=")) {
              let num = option.substring(9);
              if (!num.match(/\d+/))
                this.fatalError("BIG-STEP argument must be a non-negative integer",lineNumber);
              this.bigStep = Number(num);
              bigStepFlag = true;
            }
            else if (option.startsWith("NONTRADE-COST=")) {
              let num = option.substring(14);
              if (!num.match(/[1-9]\d*/))
                this.fatalError("NONTRADE-COST argument must be a positive integer",lineNumber);
              this.nonTradeCost = Number(num);
            }
            else if (option.startsWith("ITERATIONS=")) {
              let num = option.substring(11);
              if (!num.match(/[1-9]\d*/))
                this.fatalError("ITERATIONS argument must be a positive integer",lineNumber);
              this.iterations = Number(num);
            }
            else if (option.startsWith("SEED=")) {
              let num = option.substring(5);
              if (!num.match(/[1-9]\d*/))
                this.fatalError("SEED argument must be a positive integer",lineNumber);
              this.graph.setSeed(Number(num));
            }
            else if (option.startsWith("SHRINK=")) {
              let num = option.substring(7);
              if (!num.match(/[0-9]/)) {
                this.fatalError("SHRINK argument must be a single digit",lineNumber);
              }
              this.shrinkLevel = Number(num);
            }
            else if (option == "SHRINK-VERBOSE") {
              this.shrinkVerbose = true;
            }
            else if (option == "SHOW-WANTS") {
              this.showWants = true;
            }
            else if (option.startsWith("METRIC=")) {
              let metric = option.substring(7);
              metric = metric.replace(/\s+/,"");
	      let metrics = metric.split(/,/);
              this.metric = [];
              for( let m of metrics ) {
                if( metricmap[m] == null )
                  this.fatalError("unknown METRIC="+m,lineNumber);
                else
                  this.metric.push(metricmap[m]);
              }
            }
            else
              this.fatalError("Unknown option \""+option+"\"",lineNumber);

            this.options.push(option);
          }
        continue;
      }
      if( line.match("#.*") ) {
        if( line.indexOf('+') == 1 ) // #+ prefixed comments copy to our output
          this.outputln(line);
        continue; // skip comment line
      }
      if( line.indexOf("#") != -1 )
        if( readingOfficialNames ) {
          if( line.split("[:\\s]")[0].indexOf("#") != -1 ) {
            this.fatalError("# symbol cannot be used in an item name",lineNumber);
          }
        }
	else {
          this.fatalError("Comments (#...) cannot be used after beginning of line",lineNumber);
        }

      if( line.search(/!BEGIN-OFFICIAL-NAMES/i) != -1 ) {
        if( this.officialNames != null )
          this.fatalError("Cannot begin official names more than once", lineNumber);
        if( wantLists.length > 0 )
          this.fatalError("Official names cannot be declared after first real want list", lineNumber);

        this.officialNames = new Array();
        readingOfficialNames = true;
        continue;
      }
      if( line.search(/!END-OFFICIAL-NAMES/i) != -1 ) {
        if( ! readingOfficialNames )
          this.fatalError("!END-OFFICIAL-NAMES without matching !BEGIN-OFFICIAL-NAMES", lineNumber);
        readingOfficialNames = false;
        continue;
      }
      if( readingOfficialNames ) {
        if( line.charAt(0) == ':' )
          fatalError("Line cannot begin with colon",lineNumber);
        if( line.charAt(0) == '%' )
          fatalError("Cannot give official names for dummy items",lineNumber);

        let toks = line.split(/\s+/);
        let name = toks[0];
        if( ! this.caseSensitive )
          name = name.toUpperCase();
        if( this.officialNames[name] )
          this.fatalError("Official name "+name+"+ already defined",lineNumber);
        this.officialNames[name] = true;
        continue;
      }

      if( line.indexOf('(') == -1 && this.requireUsername )
        fatalError("Missing username with REQUIRE-USERNAMES selected",lineNumber);
      if( line.charAt(0) == '(' ) {
        if( line.lastIndexOf('(') > 0 )
          fatalError("Cannot have more than one '(' per line",lineNumber);
        let close = line.indexOf(')');
        if( close == -1 )
          fatalError("Missing ')' in username",lineNumber);
        if (close == line.length-1)
          fatalError("Username cannot appear on a line by itself",lineNumber);
        if (line.lastIndexOf(")") > close)
          fatalError("Cannot have more than one ')' per line",lineNumber);
        if (close == 1)
          fatalError("Cannot have empty parentheses",lineNumber);

        // temporarily replace spaces in username with #'s
        if( line.indexOf(' ') < close )
          line = line.substring(0,close+1).replace(/ /g,"#") + " "
                    + line.substring(close+1);
      }

      line = line.replace(":", "").replace(";", " ; ").replace(")", ") ");

      if( ! this.caseSensitive )
        line = line.toUpperCase();

      let splitedup = line.trim().split(/\s+/);

      wantLists.push(splitedup);
    }
  }

  buildGraph(wantLists) {
    let unknowns = [];

    for( let i = 0 ; i < wantLists.length ; i++ ) {
      let list = wantLists[i];
      let name = list[0];
      let user = null;
      let offset = 0;

      if( name.charAt(0) == '(' ) {
        user = name.replace(/#/g, " ");
        list.shift(); // removes what's at index 0 and shrinks array
        wantLists[i] = list;
        name = list[0];
      }

// todo ....

      let isDummy = name.charAt(0) == '%';
      if( isDummy ) {
        if( user == null )
          this.errors.push("**** Dummy item " + name + " declared without a username.");
        else if (!this.allowDummies)
          this.errors.push("**** Dummy items not allowed. ("+name+")");
        else {
          name += " for user " + user;
          list[0] = name;
        }
      }
      if( this.officialNames != null && ! this.officialNames[name] && name.charAt(0) != '%' ) {
        this.errors.push("**** Cannot define want list for "+name+" because it is not an official name.  (Usually indicates a typo by the item owner.)");
        wantLists[i] = null;
      }
      else if( this.graph.getVertex(name) != null ) {
        this.errors.push("**** Item " + name + " has multiple want lists--ignoring all but first.  (Sometimes the result of an accidental line break in the middle of a want list.)");
        wantLists[i] = null;
      }
      else {
        this.ITEMS++;
        if( isDummy )
          this.DUMMY_ITEMS++;
        let vertex = this.graph.addVertex(name,user,isDummy);
        if( this.officialNames != null && this.officialNames[name] )
          this.usedNames.push(name);

        if( ! isDummy )
          this.width = Math.max(this.width, this.show(vertex).length);
      }
    }

    // create the edges
    for( let list of wantLists ) {
      if( list == null )
        continue;

      let fromName = list[0];
      let fromVertex = this.graph.getVertex(fromName);

      // add the "no-trade" edge to itself
      this.graph.addEdge(fromVertex,fromVertex.twin,this.nonTradeCost);

      let rank = 1;

      for( let i = 1 ; i < list.length ; i++ ) {
        let toName = list[i];

        if( toName == ";" ) {
          rank += this.bigStep;
          continue;
        }

        if( toName.indexOf('=') != -1 ) {
          if( this.priorityScheme != EXPLICIT_PRIORITIES ) {
            this.errors.push("**** Cannot use '=' annotation in item "+toName+" in want list for item "+fromName+" unless using EXPLICIT_PRIORITIES.");
            continue;
          }
          if( toName.match(/[^=]+=[0-9]+/) == null ) {
            errors.push("**** Item "+toName+" in want list for item "+fromName+" must have the format 'name=number'.");
            continue;
          }
          let parts = toName.split("=");
          let explicitCost = Number(parts[1]);
          if( explicitCost < 1 ) {
            errors.push("**** Explicit priority must be positive in item "+toName+" in want list for item "+fromName+".");
            continue;
          }
          rank = explicitCost;
          toName = parts[0];
        }
        if( toName.charAt(0) == '%' ) {
          if( fromVertex.user == null ) {
            errors.push("**** Dummy item " + toName + " used in want list for item " + fromName + ", which does not have a username.");
            continue;
          }

          toName += " for user " + fromVertex.user;
        }

        let toVertex = this.graph.getVertex(toName);
        if( toVertex == null ) {
          if( this.officialNames != null && this.officialNames[toName] ) {
            // this is an official item whose owner did not submit a want list
            rank += this.smallStep;
          }
          else {
            let occurances = unknowns[toName] ? unknowns[toName] : 0;
            unknowns[toName] = occurances + 1;
          }
          continue;
        }

        toVertex = toVertex.twin;
        if( toVertex == fromVertex.twin )
          this.errors.push("**** Item " + toName + " appears in its own want list.");
        else if( this.graph.getEdge(fromVertex,toVertex) != null ) {
          if( this.showRepeats )
            this.errors.push("**** Item " + toName + " is repeated in want list for " + fromName + ".");
        }
        else if( ! toVertex.isDummy && fromVertex.user != null && fromVertex.user == toVertex.user ) {
          this.errors.push("**** Item "+fromVertex.name +" contains item "+toVertex.name+" from the same user ("+fromVertex.user+")");
        }
        else {
          let cost = UNIT;

          switch( this.priorityScheme ) {
            case LINEAR_PRIORITIES:   cost = rank; break;
            case TRIANGLE_PRIORITIES: cost = rank*(rank+1)/2; break;
            case SQUARE_PRIORITIES:   cost = rank*rank; break;
            case SCALED_PRIORITIES:   cost = rank; break; // assign later
            case EXPLICIT_PRIORITIES: cost = rank; break;
          }

          if( fromVertex.isDummy )
            cost = this.nonTradeCost;

          this.graph.addEdge(fromVertex, toVertex, cost);

          rank += this.smallStep;
        }
      }

      // update costs for those priority schemes that need information such as
      // number of wants
      if (!fromVertex.isDummy) {
        switch (this.priorityScheme) {
          case SCALED_PRIORITIES:
            let n = fromVertex.edges.length-1;
            for (let edge of fromVertex.edges) {
              if (edge.sender != fromVertex.twin)
                edge.cost = 1 + (edge.cost-1)*2520/n;
            }
            break;
        }
      }
    }

    this.graph.freeze();

    for( let entry in unknowns ) {
      let plural = unknowns[entry] == 1 ? "" : "s";
      this.errors.push("*** Unknown item " + entry + " (" + unknowns[entry] + " occurrence" + plural + ")");
    }
  } // buildGraph

  show(vertex) {
    if( vertex.user == null || vertex.isDummy )
      return vertex.name;
//    else if( sortByItem )
//      return vertex.name + " " + vertex.user;
    else
      return vertex.user + " " + vertex.name;
  }

  displayMatches(cycles) {
    let numTrades = 0;
    let numGroups = cycles.length;
    let totalCost = 0;
    let sumOfSquares = 0;
    let groupSizes = new Array();

    let summary = new Array();
    let loops = new Array();

    let alltrades = new Array();

    for( let cycle of cycles ) {
      let size = cycle.length;
      numTrades += size;
      sumOfSquares += size*size;
      groupSizes.push(size);
      for( let v of cycle ) {
        loops.push(this.pad(this.show(v)) + " receives " + this.show(v.match.twin));
        summary.push(this.pad(this.show(v)) + " receives " + this.pad(this.show(v.match.twin)) + " and sends to " + this.show(v.twin.match));
        alltrades.push(this.show(v) + " receives " + this.show(v.match.twin));
        totalCost += v.matchCost;
      }
      loops.push("");
    }

    let resultChecksum = null;

    let hash = md5.create();
    for( let trade of alltrades.sort() ) {
      hash.update(trade);
      hash.update('\n');
    }
    resultChecksum = hash.hex();

    if( this.showNonTrades ) {
      for( let v of this.graph.receivers ) {
        if( v.match == v.twin && ! v.isDummy )
          summary.push(show(v) + "             does not trade");
      }

      for( let v of this.graph.orphans ) {
        if( ! v.isDummy )
          summary.push(this.pad(show(v)) + "             does not trade");
      }
    }

    if( this.showLoops ) {
      this.outputln("TRADE LOOPS (" + numTrades + " total trades):");
      this.outputln("");
      for( let item of loops )
        this.outputln(item);
    }

    if( this.showSummary ) {
      this.outputln("ITEM SUMMARY (" + numTrades + " total trades):");
      this.outputln("");
      for( let item of summary.sort() )
        this.outputln(item);
      this.outputln("");
    }

    this.outputln("Results Checksum: " + resultChecksum + "\n");

    if( this.showStats ) {
      this.output("Num trades   = " + numTrades + " of " + (this.ITEMS-this.DUMMY_ITEMS) + " items");
      if( this.ITEMS-this.DUMMY_ITEMS == 0 )
        this.outputln("");
      else {
        let x = numTrades/(this.ITEMS-this.DUMMY_ITEMS)*100;
        this.outputln(" (" + x.toFixed(1) + "%)");
      }
      this.output("Total cost   = " + totalCost);
      if( numTrades == 0 )
        this.outputln("");
      else {
        let avgcost = totalCost / numTrades;
        this.outputln(" (avg " + avgcost.toFixed(2) + ")");
      }
      this.outputln("Num groups   = " + numGroups);
      this.output("Group sizes  =");
      for( let groupSize of groupSizes.sort(function(a, b){return b - a}) )
        this.output(" " + groupSize);
      this.outputln("");
      this.outputln("Sum squares  = " + sumOfSquares);
    }

    if( this.graph.randomSequence.length > 0 ) {
      this.outputln("\n# Random Numbers: " + this.graph.randomSequence.length);
      let all = "";
      let line = "";
      for( let number of this.graph.randomSequence ) {
        line += " " + number;
        if( line.length > 72 ) {
          all += "#" + line + "\n";
          line = "";
        }
      }
      if( line.length > 0 )
        all += "#" + line + "\n";
      this.output(all);
    }
  } // displayMatches

  pad(name) {
    while( name.length < this.width )
      name += " ";
    return name;
  }

  nameOf(v) {
    return v.name.split(" ")[0];
  }

  printWants() {
// todo
  }
} // class TradeMaximizer

/*
var tm = new TradeMaximizer();
tm.run();
alert(tm.outputstr);
*/
