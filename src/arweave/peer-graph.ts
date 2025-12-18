/**
 * Peer graph data structure and analysis metrics
 */

import type { ArweaveNode, PeerEdge } from './arweave-types.js';

export class PeerGraph {
  private adjacencyList: Map<string, Set<string>> = new Map();
  private reverseAdjacencyList: Map<string, Set<string>> = new Map();
  private nodeData: Map<string, ArweaveNode> = new Map();
  private edges: PeerEdge[] = [];

  constructor(nodes: Map<string, ArweaveNode>, edges: PeerEdge[]) {
    this.nodeData = nodes;
    this.edges = edges;
    this.buildGraph();
  }

  private buildGraph(): void {
    // Initialize adjacency lists for all nodes
    for (const address of this.nodeData.keys()) {
      this.adjacencyList.set(address, new Set());
      this.reverseAdjacencyList.set(address, new Set());
    }

    // Add edges
    for (const edge of this.edges) {
      this.addEdge(edge.source, edge.target);
    }

    // Mark bidirectional edges
    this.markBidirectionalEdges();
  }

  private addEdge(source: string, target: string): void {
    // Forward edge
    if (!this.adjacencyList.has(source)) {
      this.adjacencyList.set(source, new Set());
    }
    this.adjacencyList.get(source)!.add(target);

    // Reverse edge for inbound tracking
    if (!this.reverseAdjacencyList.has(target)) {
      this.reverseAdjacencyList.set(target, new Set());
    }
    this.reverseAdjacencyList.get(target)!.add(source);
  }

  private markBidirectionalEdges(): void {
    for (const edge of this.edges) {
      // Check if reverse edge exists
      const reverseExists = this.adjacencyList.get(edge.target)?.has(edge.source) || false;
      edge.bidirectional = reverseExists;
    }
  }

  // Basic metrics
  getOutDegree(node: string): number {
    return this.adjacencyList.get(node)?.size || 0;
  }

  getInDegree(node: string): number {
    return this.reverseAdjacencyList.get(node)?.size || 0;
  }

  getDegree(node: string): number {
    // For undirected analysis, count unique connections
    const outbound = this.adjacencyList.get(node) || new Set();
    const inbound = this.reverseAdjacencyList.get(node) || new Set();
    const allPeers = new Set([...outbound, ...inbound]);
    return allPeers.size;
  }

  getNeighbors(node: string): Set<string> {
    const outbound = this.adjacencyList.get(node) || new Set();
    const inbound = this.reverseAdjacencyList.get(node) || new Set();
    return new Set([...outbound, ...inbound]);
  }

  isBidirectional(source: string, target: string): boolean {
    const hasForward = this.adjacencyList.get(source)?.has(target) || false;
    const hasReverse = this.adjacencyList.get(target)?.has(source) || false;
    return hasForward && hasReverse;
  }

  // Network-level metrics
  calculateDensity(): number {
    const n = this.nodeData.size;
    if (n < 2) return 0;
    const maxEdges = n * (n - 1); // Directed graph
    return this.edges.length / maxEdges;
  }

  countBidirectionalEdges(): number {
    return this.edges.filter((e) => e.bidirectional).length / 2; // Divide by 2 since each bidirectional is counted twice
  }

  // Clustering coefficient for a node
  calculateClusteringCoefficient(node: string): number {
    const neighbors = this.getNeighbors(node);
    const k = neighbors.size;

    if (k < 2) return 0;

    // Count edges between neighbors
    let edgesBetweenNeighbors = 0;
    const neighborArray = Array.from(neighbors);

    for (let i = 0; i < neighborArray.length; i++) {
      for (let j = i + 1; j < neighborArray.length; j++) {
        if (
          this.adjacencyList.get(neighborArray[i])?.has(neighborArray[j]) ||
          this.adjacencyList.get(neighborArray[j])?.has(neighborArray[i])
        ) {
          edgesBetweenNeighbors++;
        }
      }
    }

    // Clustering coefficient = actual edges / possible edges
    const possibleEdges = (k * (k - 1)) / 2;
    return edgesBetweenNeighbors / possibleEdges;
  }

  // Average clustering coefficient for entire network
  calculateAvgClusteringCoefficient(): number {
    let sum = 0;
    let count = 0;

    for (const node of this.nodeData.keys()) {
      const cc = this.calculateClusteringCoefficient(node);
      if (!isNaN(cc)) {
        sum += cc;
        count++;
      }
    }

    return count > 0 ? sum / count : 0;
  }

  // Betweenness centrality using Brandes algorithm
  calculateBetweennessCentrality(): Map<string, number> {
    const betweenness = new Map<string, number>();
    const nodes = Array.from(this.nodeData.keys());

    // Initialize
    for (const node of nodes) {
      betweenness.set(node, 0);
    }

    // For each source node
    for (const source of nodes) {
      // Single-source shortest paths (BFS)
      const stack: string[] = [];
      const predecessors = new Map<string, string[]>();
      const sigma = new Map<string, number>(); // Number of shortest paths
      const distance = new Map<string, number>();

      for (const node of nodes) {
        predecessors.set(node, []);
        sigma.set(node, 0);
        distance.set(node, -1);
      }

      sigma.set(source, 1);
      distance.set(source, 0);

      const queue: string[] = [source];

      while (queue.length > 0) {
        const v = queue.shift()!;
        stack.push(v);

        const neighbors = this.getNeighbors(v);
        for (const w of neighbors) {
          // First visit?
          if (distance.get(w) === -1) {
            queue.push(w);
            distance.set(w, distance.get(v)! + 1);
          }

          // Shortest path to w via v?
          if (distance.get(w) === distance.get(v)! + 1) {
            sigma.set(w, sigma.get(w)! + sigma.get(v)!);
            predecessors.get(w)!.push(v);
          }
        }
      }

      // Accumulation
      const delta = new Map<string, number>();
      for (const node of nodes) {
        delta.set(node, 0);
      }

      while (stack.length > 0) {
        const w = stack.pop()!;
        for (const v of predecessors.get(w)!) {
          const contribution = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
          delta.set(v, delta.get(v)! + contribution);
        }
        if (w !== source) {
          betweenness.set(w, betweenness.get(w)! + delta.get(w)!);
        }
      }
    }

    // Normalize (for undirected graph, divide by 2)
    const n = nodes.length;
    const normFactor = n > 2 ? 2 / ((n - 1) * (n - 2)) : 1;

    for (const [node, value] of betweenness) {
      betweenness.set(node, value * normFactor);
    }

    return betweenness;
  }

  // Find connected components
  findConnectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const node of this.nodeData.keys()) {
      if (visited.has(node)) continue;

      // BFS to find component
      const component: string[] = [];
      const queue: string[] = [node];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;

        visited.add(current);
        component.push(current);

        const neighbors = this.getNeighbors(current);
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }

      components.push(component);
    }

    return components.sort((a, b) => b.length - a.length);
  }

  // Export for Cytoscape.js visualization
  toCytoscapeFormat(): { nodes: CytoscapeNode[]; edges: CytoscapeEdge[] } {
    const cytoscapeNodes: CytoscapeNode[] = [];
    const cytoscapeEdges: CytoscapeEdge[] = [];

    for (const [address, node] of this.nodeData) {
      cytoscapeNodes.push({
        data: {
          id: address,
          label: node.ip,
          degree: this.getDegree(address),
          inDegree: this.getInDegree(address),
          outDegree: this.getOutDegree(address),
          responsive: node.isResponsive,
          version: node.version,
          height: node.height,
        },
      });
    }

    // Deduplicate edges for visualization (show bidirectional as single edge)
    const seenEdges = new Set<string>();
    for (const edge of this.edges) {
      const edgeKey = [edge.source, edge.target].sort().join('|');
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      cytoscapeEdges.push({
        data: {
          id: `${edge.source}-${edge.target}`,
          source: edge.source,
          target: edge.target,
          bidirectional: edge.bidirectional,
        },
      });
    }

    return { nodes: cytoscapeNodes, edges: cytoscapeEdges };
  }

  // Getters
  getNodes(): Map<string, ArweaveNode> {
    return this.nodeData;
  }

  getEdges(): PeerEdge[] {
    return this.edges;
  }

  getNodeCount(): number {
    return this.nodeData.size;
  }

  getEdgeCount(): number {
    return this.edges.length;
  }
}

// Cytoscape format types
interface CytoscapeNode {
  data: {
    id: string;
    label: string;
    degree: number;
    inDegree: number;
    outDegree: number;
    responsive: boolean;
    version?: number;
    height?: number;
    [key: string]: unknown;
  };
}

interface CytoscapeEdge {
  data: {
    id: string;
    source: string;
    target: string;
    bidirectional: boolean;
    [key: string]: unknown;
  };
}
