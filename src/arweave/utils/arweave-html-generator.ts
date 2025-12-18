/**
 * HTML report generator for Arweave node analysis with Globe.gl visualization
 */

import type { ArweaveNetworkReport, ArweaveNodeAnalysis } from '../arweave-types.js';
import type { PeerGraph } from '../peer-graph.js';

// Maximum edges to display (more will freeze the browser)
const MAX_EDGES_FOR_DISPLAY = 3000;
const MAX_NODES_FOR_DISPLAY = 500;

export function generateArweaveHTML(
  report: ArweaveNetworkReport,
  nodes: ArweaveNodeAnalysis[],
  graph: PeerGraph,
  csvFilename?: string,
  jsonFilename?: string
): string {
  const cytoscapeData = graph.toCytoscapeFormat();

  // Filter to responsive nodes with geo data for globe
  const nodesWithGeo = nodes.filter(n => n.isResponsive && n.latitude && n.longitude);

  // For Cytoscape, filter to responsive nodes only
  const responsiveAddresses = new Set(
    nodes.filter(n => n.isResponsive).map(n => n.address)
  );

  let filteredNodeAddresses = responsiveAddresses;
  if (responsiveAddresses.size > MAX_NODES_FOR_DISPLAY) {
    const sortedResponsive = nodes
      .filter(n => n.isResponsive)
      .sort((a, b) => (b.degree || 0) - (a.degree || 0))
      .slice(0, MAX_NODES_FOR_DISPLAY);
    filteredNodeAddresses = new Set(sortedResponsive.map(n => n.address));
  }

  const displayNodes = cytoscapeData.nodes.filter(n => filteredNodeAddresses.has(n.data.id));

  let displayEdges = cytoscapeData.edges.filter(e =>
    filteredNodeAddresses.has(e.data.source) && filteredNodeAddresses.has(e.data.target)
  );

  if (displayEdges.length > MAX_EDGES_FOR_DISPLAY) {
    displayEdges.sort((a, b) => {
      if (a.data.bidirectional && !b.data.bidirectional) return -1;
      if (!a.data.bidirectional && b.data.bidirectional) return 1;
      return 0;
    });
    displayEdges = displayEdges.slice(0, MAX_EDGES_FOR_DISPLAY);
  }

  const edgeLimited = cytoscapeData.edges.length > displayEdges.length;
  const nodeLimited = cytoscapeData.nodes.length > displayNodes.length;

  // Enhance nodes with analysis data
  const enhancedNodes = displayNodes.map((n) => {
    const analysis = nodes.find((node) => node.address === n.data.id);
    return {
      data: {
        ...n.data,
        score: analysis?.overallCentralization || 0,
        country: analysis?.country || 'Unknown',
        countryCode: analysis?.countryCode || '',
        isp: analysis?.isp || 'Unknown',
        clusterId: analysis?.clusterId || '',
        betweenness: analysis?.betweennessCentrality || 0,
        hosting: analysis?.hosting || false,
        lat: analysis?.latitude,
        lng: analysis?.longitude,
      },
    };
  });

  // Prepare globe data - nodes with geo coordinates
  const globeNodes = nodesWithGeo.map(n => ({
    lat: n.latitude,
    lng: n.longitude,
    ip: n.ip,
    address: n.address,
    score: n.overallCentralization,
    country: n.country || 'Unknown',
    isp: n.isp || 'Unknown',
    clusterId: n.clusterId || '',
    degree: n.degree || 0,
  }));

  // Prepare globe arcs - edges between nodes with geo
  const nodeGeoMap = new Map(nodesWithGeo.map(n => [n.address, { lat: n.latitude!, lng: n.longitude! }]));
  const globeArcs = displayEdges
    .filter(e => nodeGeoMap.has(e.data.source) && nodeGeoMap.has(e.data.target))
    .slice(0, 1000) // Limit arcs for performance
    .map(e => {
      const src = nodeGeoMap.get(e.data.source)!;
      const tgt = nodeGeoMap.get(e.data.target)!;
      return {
        startLat: src.lat,
        startLng: src.lng,
        endLat: tgt.lat,
        endLng: tgt.lng,
        bidirectional: e.data.bidirectional,
      };
    });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Arweave Node Network Analysis - ${report.timestamp.split('T')[0]}</title>
  <script src="https://unpkg.com/globe.gl@2.27.0/dist/globe.gl.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
  <script src="https://unpkg.com/layout-base/layout-base.js"></script>
  <script src="https://unpkg.com/cose-base/cose-base.js"></script>
  <script src="https://unpkg.com/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-card: #334155;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent: #3b82f6;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #10b981;
      --border: #475569;
    }
    .light-theme {
      --bg-primary: #f8fafc;
      --bg-secondary: #e2e8f0;
      --bg-card: #ffffff;
      --text-primary: #1e293b;
      --text-secondary: #64748b;
      --border: #cbd5e1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
    }
    .container { max-width: 1600px; margin: 0 auto; padding: 20px; }
    header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 20px 0; border-bottom: 1px solid var(--border); margin-bottom: 20px;
    }
    header h1 { font-size: 1.8rem; font-weight: 600; }
    header .subtitle { color: var(--text-secondary); font-size: 0.9rem; }
    .theme-toggle {
      background: var(--bg-card); border: 1px solid var(--border);
      color: var(--text-primary); padding: 8px 16px; border-radius: 6px; cursor: pointer;
    }
    .stats-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px; margin-bottom: 24px;
    }
    .stat-card {
      background: var(--bg-card); padding: 20px; border-radius: 12px;
      border: 1px solid var(--border); position: relative;
    }
    .stat-card .label { color: var(--text-secondary); font-size: 0.85rem; text-transform: uppercase; }
    .stat-card .value { font-size: 2rem; font-weight: 700; margin-top: 4px; }
    .stat-card .value.danger { color: var(--danger); }
    .stat-card .value.warning { color: var(--warning); }
    .stat-card .value.success { color: var(--success); }
    .stat-card .info-icon {
      position: absolute; top: 12px; right: 12px; width: 18px; height: 18px;
      background: var(--bg-secondary); border-radius: 50%; cursor: help;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; color: var(--text-secondary);
    }
    .stat-card .tooltip {
      display: none; position: absolute; top: 40px; right: 0; width: 280px;
      background: var(--bg-primary); border: 1px solid var(--border);
      padding: 12px; border-radius: 8px; font-size: 0.85rem; z-index: 100;
      color: var(--text-secondary); line-height: 1.5;
    }
    .stat-card:hover .tooltip { display: block; }
    .toggle-group {
      display: flex; border-radius: 6px; overflow: hidden; border: 1px solid var(--border);
    }
    .toggle-btn {
      padding: 6px 12px; border: none; background: var(--bg-secondary); color: var(--text-secondary);
      cursor: pointer; font-size: 0.85rem; transition: all 0.2s;
    }
    .toggle-btn:not(:last-child) { border-right: 1px solid var(--border); }
    .toggle-btn.active { background: var(--accent); color: white; }
    .toggle-btn:hover:not(.active) { background: var(--bg-card); }
    .tabs {
      display: flex; gap: 4px; border-bottom: 1px solid var(--border);
      margin-bottom: 20px; overflow-x: auto;
    }
    .tab {
      padding: 12px 24px; background: transparent; border: none;
      color: var(--text-secondary); cursor: pointer; font-size: 0.95rem;
      border-bottom: 2px solid transparent; white-space: nowrap;
    }
    .tab:hover { color: var(--text-primary); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    #globe-container {
      width: 100%; height: 700px; border-radius: 12px; overflow: hidden;
      background: #000011; position: relative;
    }
    #globe-container.loading::after {
      content: 'Loading globe...'; position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%); color: var(--text-secondary);
      font-size: 1.2rem;
    }
    .light-theme #globe-container { background: #1a1a2e; }
    .globe-controls {
      position: absolute; top: 20px; left: 20px; z-index: 100;
      background: var(--bg-card); padding: 16px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); min-width: 180px;
    }
    .globe-control-item { margin-bottom: 8px; }
    .globe-control-item label {
      display: flex; align-items: center; gap: 8px; font-size: 0.85rem;
      color: var(--text-primary); cursor: pointer;
    }
    .globe-legend {
      position: absolute; bottom: 20px; right: 20px; z-index: 100;
      background: var(--bg-card); padding: 12px 16px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    #cy {
      width: 100%; height: 600px; background: var(--bg-secondary);
      border-radius: 12px; border: 1px solid var(--border);
    }
    .graph-controls {
      display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;
    }
    .graph-controls select, .graph-controls button {
      padding: 8px 16px; background: var(--bg-card); border: 1px solid var(--border);
      color: var(--text-primary); border-radius: 6px; cursor: pointer;
    }
    .graph-controls label { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); }
    .node-info-panel {
      position: fixed; top: 100px; right: 20px; width: 320px; max-width: calc(100vw - 40px);
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 12px; padding: 20px; display: none; z-index: 1000;
      max-height: calc(100vh - 140px); overflow-y: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .node-info-panel.visible { display: block; }
    .node-info-panel h3 { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    .node-info-panel .close-btn {
      position: absolute; top: 12px; right: 12px; background: none;
      border: none; color: var(--text-secondary); font-size: 1.5rem; cursor: pointer;
    }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .info-row .label { color: var(--text-secondary); }
    .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
    .chart-card {
      background: var(--bg-card); padding: 20px; border-radius: 12px;
      border: 1px solid var(--border);
    }
    .chart-card h3 { margin-bottom: 16px; font-size: 1.1rem; }
    .chart-container { position: relative; height: 300px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: var(--bg-secondary); font-weight: 600; position: sticky; top: 0; }
    tr:hover { background: var(--bg-secondary); }
    .table-container { max-height: 600px; overflow-y: auto; border-radius: 12px; border: 1px solid var(--border); }
    .score-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 0.8rem; font-weight: 600;
    }
    .score-badge.high { background: var(--danger); color: white; }
    .score-badge.medium { background: var(--warning); color: black; }
    .score-badge.low { background: var(--success); color: white; }
    .search-box {
      padding: 10px 16px; background: var(--bg-card); border: 1px solid var(--border);
      color: var(--text-primary); border-radius: 8px; width: 300px; margin-bottom: 16px;
    }
    .legend { display: flex; gap: 20px; margin-top: 16px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: var(--text-secondary); }
    .legend-color { width: 16px; height: 16px; border-radius: 50%; }
    .cluster-card {
      background: var(--bg-card); padding: 16px; border-radius: 8px;
      border: 1px solid var(--border); margin-bottom: 12px;
    }
    .cluster-card h4 { margin-bottom: 8px; }
    .cluster-meta { display: flex; gap: 16px; flex-wrap: wrap; color: var(--text-secondary); font-size: 0.9rem; }
    .export-btn {
      padding: 10px 20px; border: none; border-radius: 8px; font-weight: 500;
      cursor: pointer; transition: all 0.2s; background: var(--accent); color: white;
    }
    .export-btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .export-btn.secondary { background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border); }
    .section-desc {
      background: var(--bg-secondary); padding: 16px; border-radius: 8px;
      margin-bottom: 20px; color: var(--text-secondary); font-size: 0.9rem;
    }
    .graph-notice {
      background: var(--bg-card); padding: 12px 16px; border-radius: 8px;
      border: 1px solid var(--border); margin-bottom: 16px; font-size: 0.9rem;
      color: var(--text-secondary);
    }
    @media (max-width: 768px) {
      .container { padding: 12px; }
      header h1 { font-size: 1.4rem; }
      #globe-container, #cy { height: 400px; }
      .node-info-panel {
        top: auto; bottom: 0; left: 0; right: 0;
        width: 100%; max-width: 100%; border-radius: 12px 12px 0 0;
        max-height: 50vh;
      }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .charts-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Arweave Node Network Analysis</h1>
        <div class="subtitle">Generated: ${report.timestamp} | Nodes Discovered: ${report.totalNodesDiscovered}</div>
      </div>
      <button class="theme-toggle" onclick="toggleTheme()">Toggle Theme</button>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Total Nodes</div>
        <div class="value">${report.totalNodesDiscovered}</div>
        <div class="info-icon">?</div>
        <div class="tooltip">Total unique node addresses discovered via peer crawling. Includes both responsive and unresponsive nodes.</div>
      </div>
      <div class="stat-card">
        <div class="label">Responsive</div>
        <div class="value success">${report.totalNodesResponsive}</div>
        <div class="info-icon">?</div>
        <div class="tooltip">Nodes that responded to /info requests. These are confirmed active Arweave nodes.</div>
      </div>
      <div class="stat-card">
        <div class="label">High Concentration</div>
        <div class="value ${report.highCentralization > 0 ? 'danger' : ''}">${report.highCentralization}</div>
        <div class="info-icon">?</div>
        <div class="tooltip">Nodes with concentration score > 0.7. These are in highly concentrated infrastructure (same IP range, ISP, or datacenter as many others).</div>
      </div>
      <div class="stat-card">
        <div class="label">Clusters Found</div>
        <div class="value warning">${report.clusters.length}</div>
        <div class="info-icon">?</div>
        <div class="tooltip">Groups of nodes sharing infrastructure (same /24 IP range or ISP+city). May indicate single operators running multiple nodes.</div>
      </div>
      <div class="stat-card">
        <div class="label">Network Density</div>
        <div class="value">${(report.networkDensity * 100).toFixed(2)}%</div>
        <div class="info-icon">?</div>
        <div class="tooltip">Percentage of possible peer connections that exist. Higher = more interconnected network. Formula: edges / (nodes × (nodes-1))</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" onclick="switchTab('globe')">Globe View</button>
      <button class="tab" onclick="switchTab('graph')">Peer Graph</button>
      <button class="tab" onclick="switchTab('overview')">Overview</button>
      <button class="tab" onclick="switchTab('infrastructure')">Infrastructure</button>
      <button class="tab" onclick="switchTab('clusters')">Clusters</button>
      <button class="tab" onclick="switchTab('all-nodes')">All Nodes</button>
    </div>

    <!-- Globe View Tab -->
    <div id="globe" class="tab-content active">
      <div class="section-desc">
        Interactive 3D globe showing node locations. Node size indicates peer count (degree).
        Click nodes for details. Arcs show peer connections (limited to ${globeArcs.length} for performance).
        ${nodesWithGeo.length === 0 ? '<br/><strong style="color: var(--warning);">Note: No nodes have geographic data. Enable geo lookup or check API connectivity.</strong>' : ''}
      </div>
      <div id="globe-container" class="loading">
        <div class="globe-controls">
          <h4 style="margin-bottom: 12px; font-size: 0.9rem;">Controls</h4>
          <div class="globe-control-item">
            <label><input type="checkbox" id="globeAutoRotate" checked onchange="toggleGlobeRotate()"> Auto-rotate</label>
          </div>
          <div class="globe-control-item">
            <label><input type="checkbox" id="globeShowArcs" checked onchange="toggleGlobeArcs()"> Show peer arcs</label>
          </div>
          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
            <div style="font-size: 0.85rem; margin-bottom: 8px; color: var(--text-secondary);">Color by:</div>
            <div class="globe-control-item">
              <label><input type="radio" name="globeColorMode" value="concentration" checked onchange="updateGlobeColorMode()"> Concentration</label>
            </div>
            <div class="globe-control-item">
              <label><input type="radio" name="globeColorMode" value="provider" onchange="updateGlobeColorMode()"> Hosting Provider</label>
            </div>
            <div class="globe-control-item">
              <label><input type="radio" name="globeColorMode" value="country" onchange="updateGlobeColorMode()"> Country</label>
            </div>
          </div>
          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
            <div style="font-size: 0.85rem; margin-bottom: 8px; color: var(--text-secondary);">Filter by risk:</div>
            <div class="globe-control-item">
              <label><input type="checkbox" id="globeShowLow" checked onchange="updateGlobeFilters()"> Low risk</label>
            </div>
            <div class="globe-control-item">
              <label><input type="checkbox" id="globeShowMedium" checked onchange="updateGlobeFilters()"> Medium risk</label>
            </div>
            <div class="globe-control-item">
              <label><input type="checkbox" id="globeShowHigh" checked onchange="updateGlobeFilters()"> High risk</label>
            </div>
          </div>
        </div>
        <div class="globe-legend" id="globeLegend">
          <h4 style="margin-bottom: 8px; font-size: 0.85rem;" id="globeLegendTitle">Concentration</h4>
          <div id="globeLegendContent">
            <div class="legend-item"><div class="legend-color" style="background: #10b981;"></div><span>Low (&lt;0.4)</span></div>
            <div class="legend-item"><div class="legend-color" style="background: #f59e0b;"></div><span>Medium (0.4-0.7)</span></div>
            <div class="legend-item"><div class="legend-color" style="background: #ef4444;"></div><span>High (&gt;0.7)</span></div>
          </div>
        </div>
      </div>
      <p style="color: var(--text-secondary); font-size: 0.875rem; margin-top: 12px;">
        Showing ${nodesWithGeo.length} nodes with geographic data.
      </p>
    </div>

    <!-- Peer Graph Tab -->
    <div id="graph" class="tab-content">
      <div class="section-desc">
        Network topology graph showing peer relationships. Useful for identifying highly connected nodes
        and isolated clusters. Note: Filtered to ${displayNodes.length} nodes and ${displayEdges.length} edges for browser performance.
      </div>
      <div class="graph-controls">
        <label>
          Color by:
          <select id="colorBy" onchange="updateGraphColors()">
            <option value="concentration">Concentration</option>
            <option value="country">Country</option>
            <option value="cluster">Cluster</option>
          </select>
        </label>
        <label>
          Size by:
          <select id="sizeBy" onchange="updateGraphSizes()">
            <option value="degree">Degree</option>
            <option value="betweenness">Betweenness</option>
            <option value="score">Concentration</option>
          </select>
        </label>
        <button onclick="resetView()">Reset View</button>
        <button onclick="runLayout()">Re-layout</button>
      </div>
      <div id="cy"></div>
      <div class="legend">
        <div class="legend-item"><div class="legend-color" style="background: #ef4444;"></div> High (&gt;0.7)</div>
        <div class="legend-item"><div class="legend-color" style="background: #f59e0b;"></div> Medium (0.4-0.7)</div>
        <div class="legend-item"><div class="legend-color" style="background: #10b981;"></div> Low (&lt;0.4)</div>
      </div>
    </div>

    <!-- Overview Tab -->
    <div id="overview" class="tab-content">
      <div class="section-desc">
        Summary charts showing concentration patterns across the network.
      </div>
      <div class="charts-grid">
        <div class="chart-card">
          <h3>Concentration Distribution</h3>
          <div class="chart-container"><canvas id="riskChart"></canvas></div>
        </div>
        <div class="chart-card">
          <h3>Geographic Distribution</h3>
          <div class="chart-container"><canvas id="geoChart"></canvas></div>
        </div>
        <div class="chart-card">
          <h3>Top Hosting Providers</h3>
          <div class="chart-container"><canvas id="providerChart"></canvas></div>
        </div>
        <div class="chart-card">
          <h3>Peer Count Distribution</h3>
          <div class="chart-container"><canvas id="peerChart"></canvas></div>
        </div>
      </div>
    </div>

    <!-- Infrastructure Tab -->
    <div id="infrastructure" class="tab-content">
      <div class="section-desc">
        Infrastructure distribution analysis. Higher datacenter concentration may indicate centralization concerns,
        though datacenters also provide reliability. Diversity across ISPs and countries improves network resilience.
      </div>
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        <span style="font-size: 0.9rem; color: var(--text-secondary);">Calculate percentages against:</span>
        <div class="toggle-group">
          <button class="toggle-btn active" onclick="setInfraView('responsive')" id="infraToggleResponsive">
            Responsive Only (${report.infrastructureImpact.totalNodesResponsive || report.totalNodesResponsive})
          </button>
          <button class="toggle-btn" onclick="setInfraView('all')" id="infraToggleAll">
            All Discovered (${report.infrastructureImpact.totalNodesDiscovered || report.totalNodesDiscovered})
          </button>
        </div>
      </div>
      <div class="stats-grid" id="infraStats">
        <div class="stat-card">
          <div class="label">Datacenter Hosted</div>
          <div class="value" id="infraDatacenter">${report.infrastructureImpact.totalDatacenterHosted} (${report.infrastructureImpact.datacenterPercentage.toFixed(1)}%)</div>
        </div>
        <div class="stat-card">
          <div class="label">Unique ISPs</div>
          <div class="value" id="infraIsps">${report.infrastructureImpact.uniqueIsps}</div>
        </div>
        <div class="stat-card">
          <div class="label">Unique Countries</div>
          <div class="value" id="infraCountries">${report.infrastructureImpact.uniqueCountries}</div>
        </div>
        <div class="stat-card">
          <div class="label">Unique ASNs</div>
          <div class="value" id="infraAsns">${report.infrastructureImpact.uniqueAsns}</div>
        </div>
      </div>
      <div class="charts-grid">
        <div class="chart-card">
          <h3>Top 10 Hosting Providers</h3>
          <div class="table-container" style="max-height: 400px;">
            <table>
              <thead><tr><th>Provider</th><th>Nodes</th><th>%</th></tr></thead>
              <tbody id="infraProvidersTable">
                ${report.infrastructureImpact.topProviders
                  .map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${p.count}</td><td>${p.percentage.toFixed(1)}%</td></tr>`)
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="chart-card">
          <h3>IP Range Concentration</h3>
          <div class="table-container" style="max-height: 400px;">
            <table>
              <thead><tr><th>IP Range (/24)</th><th>Nodes</th><th>%</th></tr></thead>
              <tbody id="infraIpRangeTable">
                ${report.infrastructureImpact.ipRangeConcentration
                  .map(r => `<tr><td>${escapeHtml(r.range)}</td><td>${r.count}</td><td>${r.percentage.toFixed(1)}%</td></tr>`)
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Clusters Tab -->
    <div id="clusters" class="tab-content">
      <div class="section-desc">
        Detected clusters of nodes sharing infrastructure. Nodes in the same /24 IP range (3+) or same ISP+city (5+)
        are grouped together. These patterns may indicate single operators running multiple nodes.
      </div>
      <h2 style="margin-bottom: 20px;">Detected Clusters (${report.clusters.length})</h2>
      ${report.clusters.length === 0 ? '<p style="color: var(--text-secondary);">No significant clusters detected. The network appears well-distributed.</p>' : ''}
      ${report.clusters
        .map(c => `
        <div class="cluster-card">
          <h4>${escapeHtml(c.id)} <span class="score-badge ${c.avgScore > 0.7 ? 'high' : c.avgScore > 0.4 ? 'medium' : 'low'}">${c.avgScore.toFixed(3)}</span></h4>
          <div class="cluster-meta">
            <span>Size: ${c.size} nodes</span>
            <span>Type: ${c.clusterType}</span>
            ${c.primaryIsp ? `<span>ISP: ${escapeHtml(c.primaryIsp)}</span>` : ''}
            ${c.primaryCountry ? `<span>Country: ${escapeHtml(c.primaryCountry)}</span>` : ''}
          </div>
          <div style="margin-top: 8px; color: var(--text-secondary); font-size: 0.85rem;">
            IP Ranges: ${c.ipRanges.slice(0, 5).map(escapeHtml).join(', ')}${c.ipRanges.length > 5 ? '...' : ''}
          </div>
        </div>`)
        .join('')}
    </div>

    <!-- All Nodes Tab -->
    <div id="all-nodes" class="tab-content">
      <div class="section-desc">
        Complete list of all discovered nodes. Use the search box to filter by IP, ISP, or country.
      </div>
      <input type="text" class="search-box" placeholder="Search by IP, ISP, country..." onkeyup="filterAllNodes(this.value)">
      <div class="table-container">
        <table id="allNodesTable">
          <thead>
            <tr>
              <th>IP</th>
              <th>Port</th>
              <th>Status</th>
              <th>Score</th>
              <th>Country</th>
              <th>ISP</th>
              <th>Degree</th>
              <th>Cluster</th>
            </tr>
          </thead>
          <tbody>
            ${nodes
              .map(n => `
              <tr data-search="${escapeHtml((n.ip + ' ' + (n.isp || '') + ' ' + (n.country || '')).toLowerCase())}">
                <td>${escapeHtml(n.ip)}</td>
                <td>${n.port}</td>
                <td>${n.isResponsive ? '<span style="color: var(--success);">OK</span>' : '<span style="color: var(--danger);">Failed</span>'}</td>
                <td><span class="score-badge ${n.overallCentralization > 0.7 ? 'high' : n.overallCentralization > 0.4 ? 'medium' : 'low'}">${n.overallCentralization.toFixed(3)}</span></td>
                <td>${escapeHtml(n.country || '-')}</td>
                <td>${escapeHtml(n.isp || '-')}</td>
                <td>${n.degree || 0}</td>
                <td>${escapeHtml(n.clusterId || '-')}</td>
              </tr>`)
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Node Info Panel -->
    <div class="node-info-panel" id="nodeInfoPanel">
      <button class="close-btn" onclick="closeNodeInfo()">&times;</button>
      <h3 id="nodeInfoTitle">Node Details</h3>
      <div id="nodeInfoContent"></div>
    </div>

    ${csvFilename || jsonFilename ? `
    <div class="export-buttons" style="display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap;">
      ${csvFilename ? `<button class="export-btn" onclick="downloadFile('${csvFilename}')">📥 Download CSV</button>` : ''}
      ${jsonFilename ? `<button class="export-btn" onclick="downloadFile('${jsonFilename}')">📥 Download JSON</button>` : ''}
      <button class="export-btn secondary" onclick="window.print()">🖨️ Print Report</button>
    </div>
    ` : ''}

    <div class="timestamp" style="color: var(--text-secondary); font-size: 0.875rem; margin-top: 24px; text-align: center;">
      Generated: ${report.timestamp}
    </div>
  </div>

  <footer style="text-align: center; padding: 24px 20px; margin-top: 40px; color: var(--text-secondary); font-size: 0.875rem; border-top: 1px solid var(--border);">
    Made with ❤️ by <a href="https://github.com/vilenarios/ar-io-network-analyzer" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: none;">Vilenarios</a>
  </footer>

  <script>
    // Data
    const globeNodes = ${JSON.stringify(globeNodes)};
    const globeArcs = ${JSON.stringify(globeArcs)};
    const graphNodes = ${JSON.stringify(enhancedNodes)};
    const graphEdges = ${JSON.stringify(displayEdges)};

    // Infrastructure data for toggle
    const infraDataResponsive = {
      totalDatacenterHosted: ${report.infrastructureImpact.totalDatacenterHosted},
      datacenterPercentage: ${report.infrastructureImpact.datacenterPercentage.toFixed(1)},
      uniqueIsps: ${report.infrastructureImpact.uniqueIsps},
      uniqueCountries: ${report.infrastructureImpact.uniqueCountries},
      uniqueAsns: ${report.infrastructureImpact.uniqueAsns},
      topProviders: ${JSON.stringify(report.infrastructureImpact.topProviders)},
      ipRangeConcentration: ${JSON.stringify(report.infrastructureImpact.ipRangeConcentration)}
    };
    const infraDataAll = ${report.infrastructureImpact.allNodes ? `{
      totalDatacenterHosted: ${report.infrastructureImpact.allNodes.totalDatacenterHosted},
      datacenterPercentage: ${report.infrastructureImpact.allNodes.datacenterPercentage.toFixed(1)},
      uniqueIsps: ${report.infrastructureImpact.allNodes.uniqueIsps},
      uniqueCountries: ${report.infrastructureImpact.allNodes.uniqueCountries},
      uniqueAsns: ${report.infrastructureImpact.allNodes.uniqueAsns},
      topProviders: ${JSON.stringify(report.infrastructureImpact.allNodes.topProviders)},
      ipRangeConcentration: ${JSON.stringify(report.infrastructureImpact.allNodes.ipRangeConcentration)}
    }` : 'infraDataResponsive'};

    function setInfraView(mode) {
      const data = mode === 'responsive' ? infraDataResponsive : infraDataAll;

      // Update toggle buttons
      document.getElementById('infraToggleResponsive').classList.toggle('active', mode === 'responsive');
      document.getElementById('infraToggleAll').classList.toggle('active', mode === 'all');

      // Update stat cards
      document.getElementById('infraDatacenter').textContent = data.totalDatacenterHosted + ' (' + data.datacenterPercentage + '%)';
      document.getElementById('infraIsps').textContent = data.uniqueIsps;
      document.getElementById('infraCountries').textContent = data.uniqueCountries;
      document.getElementById('infraAsns').textContent = data.uniqueAsns;

      // Update providers table
      document.getElementById('infraProvidersTable').innerHTML = data.topProviders
        .map(p => '<tr><td>' + escapeHtmlJs(p.name) + '</td><td>' + p.count + '</td><td>' + p.percentage.toFixed(1) + '%</td></tr>')
        .join('');

      // Update IP range table
      document.getElementById('infraIpRangeTable').innerHTML = data.ipRangeConcentration
        .map(r => '<tr><td>' + escapeHtmlJs(r.range) + '</td><td>' + r.count + '</td><td>' + r.percentage.toFixed(1) + '%</td></tr>')
        .join('');
    }

    function escapeHtmlJs(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Color scales
    const colorScale = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#06b6d4', '#84cc16', '#f43f5e'];
    const countries = [...new Set(graphNodes.map(n => n.data.countryCode).filter(Boolean))];
    const countryColors = {};
    countries.forEach((c, i) => { countryColors[c] = colorScale[i % colorScale.length]; });

    // Provider colors for globe
    const providerColorMap = {
      'hetzner': '#FF6B6B', 'amazon': '#FF9F40', 'aws': '#FF9F40',
      'digitalocean': '#4ECDC4', 'ovh': '#A29BFE', 'vultr': '#74B9FF',
      'google': '#FD79A8', 'microsoft': '#A8E6CF', 'azure': '#A8E6CF',
      'linode': '#FFD93D', 'contabo': '#95E1D3'
    };

    function getProviderColor(isp, hosting) {
      if (!isp) return '#6b7280';
      const ispLower = isp.toLowerCase();
      for (const [key, color] of Object.entries(providerColorMap)) {
        if (ispLower.includes(key)) return color;
      }
      return hosting ? '#95A5A6' : '#2ECC71';
    }

    function getCountryColor(country) {
      return countryColors[country] || '#6b7280';
    }

    function getScoreColor(score) {
      if (score > 0.7) return '#ef4444';
      if (score > 0.4) return '#f59e0b';
      return '#10b981';
    }

    // Globe state
    let globeColorMode = 'concentration';
    let globeFilters = { low: true, medium: true, high: true };

    // Globe initialization
    let globe;
    function initGlobe() {
      if (globe) return;

      const container = document.getElementById('globe-container');
      if (!container) return;

      // Check if Globe.gl is loaded
      if (typeof Globe === 'undefined') {
        container.classList.remove('loading');
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ef4444;">Failed to load globe visualization. Please refresh the page.</div>';
        return;
      }

      try {
        // Ensure container has dimensions before initializing
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          // Retry after a short delay if container not ready
          setTimeout(initGlobe, 100);
          return;
        }

        globe = Globe()(container)
          .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
          .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
          .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
          .pointsData(getFilteredGlobeNodes())
          .pointLat('lat')
          .pointLng('lng')
          .pointColor(d => getGlobePointColor(d))
          .pointRadius(d => Math.max(0.5, Math.min(2.5, 0.5 + d.degree * 0.1)))
          .pointAltitude(0.02)
          .pointLabel(d => \`<div style="background: #1e293b; padding: 8px 12px; border-radius: 6px; color: white;">
            <strong>\${d.ip}</strong><br/>
            Country: \${d.country}<br/>
            ISP: \${d.isp}<br/>
            Degree: \${d.degree}<br/>
            Score: \${d.score.toFixed(3)}
          </div>\`)
          .onPointClick(d => showNodeInfo({
            id: d.address,
            label: d.ip,
            score: d.score,
            country: d.country,
            isp: d.isp,
            degree: d.degree,
            clusterId: d.clusterId
          }))
          .arcsData(globeArcs)
          .arcStartLat('startLat')
          .arcStartLng('startLng')
          .arcEndLat('endLat')
          .arcEndLng('endLng')
          .arcColor(d => d.bidirectional ? ['#3b82f6', '#3b82f6'] : ['#6b7280', '#6b7280'])
          .arcAltitude(0.1)
          .arcStroke(0.3)
          .arcDashLength(0.5)
          .arcDashGap(0.2)
          .arcDashAnimateTime(2000);

        // Auto-rotate
        globe.controls().autoRotate = true;
        globe.controls().autoRotateSpeed = 0.5;

        // Remove loading state
        container.classList.remove('loading');
        console.log('Globe initialized with', globeNodes.length, 'nodes and', globeArcs.length, 'arcs');

        // Handle window resize
        window.addEventListener('resize', () => {
          if (globe) {
            globe.width(container.offsetWidth);
            globe.height(container.offsetHeight);
          }
        });
      } catch (error) {
        console.error('Globe initialization error:', error);
        container.classList.remove('loading');
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ef4444;">Error initializing globe. See console for details.</div>';
      }
    }

    function getGlobePointColor(d) {
      if (globeColorMode === 'provider') {
        return getProviderColor(d.isp, false);
      } else if (globeColorMode === 'country') {
        return getCountryColor(d.country);
      }
      return getScoreColor(d.score);
    }

    function getFilteredGlobeNodes() {
      return globeNodes.filter(d => {
        const risk = d.score > 0.7 ? 'high' : d.score > 0.4 ? 'medium' : 'low';
        return globeFilters[risk];
      });
    }

    function toggleGlobeRotate() {
      if (!globe) return;
      globe.controls().autoRotate = document.getElementById('globeAutoRotate').checked;
    }

    function toggleGlobeArcs() {
      if (!globe) return;
      const show = document.getElementById('globeShowArcs').checked;
      globe.arcsData(show ? globeArcs : []);
    }

    function updateGlobeColorMode() {
      globeColorMode = document.querySelector('input[name="globeColorMode"]:checked').value;
      if (globe) {
        globe.pointColor(d => getGlobePointColor(d));
      }
      updateGlobeLegend();
    }

    function updateGlobeFilters() {
      globeFilters.low = document.getElementById('globeShowLow').checked;
      globeFilters.medium = document.getElementById('globeShowMedium').checked;
      globeFilters.high = document.getElementById('globeShowHigh').checked;
      if (globe) {
        globe.pointsData(getFilteredGlobeNodes());
      }
    }

    function updateGlobeLegend() {
      const title = document.getElementById('globeLegendTitle');
      const content = document.getElementById('globeLegendContent');

      if (globeColorMode === 'provider') {
        title.textContent = 'Hosting Provider';
        const providers = {};
        globeNodes.forEach(n => {
          const color = getProviderColor(n.isp, false);
          const ispLower = (n.isp || '').toLowerCase();
          let name = 'Other';
          for (const key of Object.keys(providerColorMap)) {
            if (ispLower.includes(key)) { name = key.charAt(0).toUpperCase() + key.slice(1); break; }
          }
          if (!providers[name]) providers[name] = { color, count: 0 };
          providers[name].count++;
        });
        const sorted = Object.entries(providers).sort((a, b) => b[1].count - a[1].count).slice(0, 6);
        content.innerHTML = sorted.map(([name, data]) =>
          \`<div class="legend-item"><div class="legend-color" style="background: \${data.color};"></div><span>\${name} (\${data.count})</span></div>\`
        ).join('');
      } else if (globeColorMode === 'country') {
        title.textContent = 'Country';
        const countryCounts = {};
        globeNodes.forEach(n => {
          if (n.country && n.country !== 'Unknown') {
            countryCounts[n.country] = (countryCounts[n.country] || 0) + 1;
          }
        });
        const sorted = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
        content.innerHTML = sorted.map(([country, count]) =>
          \`<div class="legend-item"><div class="legend-color" style="background: \${getCountryColor(country)};"></div><span>\${country} (\${count})</span></div>\`
        ).join('');
      } else {
        title.textContent = 'Concentration';
        content.innerHTML = \`
          <div class="legend-item"><div class="legend-color" style="background: #10b981;"></div><span>Low (&lt;0.4)</span></div>
          <div class="legend-item"><div class="legend-color" style="background: #f59e0b;"></div><span>Medium (0.4-0.7)</span></div>
          <div class="legend-item"><div class="legend-color" style="background: #ef4444;"></div><span>High (&gt;0.7)</span></div>
        \`;
      }
    }

    // Cytoscape initialization
    let cy;
    function initGraph() {
      if (cy) return;

      cy = cytoscape({
        container: document.getElementById('cy'),
        elements: { nodes: graphNodes, edges: graphEdges },
        style: [
          {
            selector: 'node',
            style: {
              'background-color': ele => getScoreColor(ele.data('score')),
              'width': ele => Math.max(15, Math.min(50, 10 + (ele.data('degree') || 0) * 0.5)),
              'height': ele => Math.max(15, Math.min(50, 10 + (ele.data('degree') || 0) * 0.5)),
              'label': '', 'font-size': '10px', 'color': '#94a3b8'
            }
          },
          {
            selector: 'edge',
            style: { 'width': 1, 'line-color': '#6b7280', 'opacity': 0.3, 'curve-style': 'bezier' }
          },
          {
            selector: 'edge[bidirectional]',
            style: { 'line-color': '#3b82f6', 'width': 1.5, 'opacity': 0.5 }
          },
          {
            selector: 'node:selected',
            style: { 'border-width': 3, 'border-color': '#ffffff' }
          }
        ],
        layout: {
          name: 'fcose', quality: 'proof', randomize: true, animate: false,
          idealEdgeLength: 150, nodeRepulsion: 8000, numIter: 1500
        },
        wheelSensitivity: 0.3
      });

      cy.on('tap', 'node', evt => showNodeInfo(evt.target.data()));
      cy.on('tap', evt => { if (evt.target === cy) closeNodeInfo(); });
    }

    function showNodeInfo(data) {
      const panel = document.getElementById('nodeInfoPanel');
      document.getElementById('nodeInfoTitle').textContent = data.label || data.id;
      document.getElementById('nodeInfoContent').innerHTML = \`
        <div class="info-row"><span class="label">Address</span><span style="font-family:monospace;font-size:0.85rem;">\${data.id || '-'}</span></div>
        <div class="info-row"><span class="label">Score</span><span class="score-badge \${data.score > 0.7 ? 'high' : data.score > 0.4 ? 'medium' : 'low'}">\${(data.score || 0).toFixed(3)}</span></div>
        <div class="info-row"><span class="label">Country</span><span>\${data.country || '-'}</span></div>
        <div class="info-row"><span class="label">ISP</span><span>\${data.isp || '-'}</span></div>
        <div class="info-row"><span class="label">Degree</span><span>\${data.degree ?? '-'}</span></div>
        \${data.version ? \`<div class="info-row"><span class="label">Version</span><span>\${data.version}</span></div>\` : ''}
        \${data.height ? \`<div class="info-row"><span class="label">Height</span><span>\${data.height.toLocaleString()}</span></div>\` : ''}
        <div class="info-row"><span class="label">Cluster</span><span>\${data.clusterId || 'None'}</span></div>
        \${data.hosting !== undefined ? \`<div class="info-row"><span class="label">Datacenter</span><span>\${data.hosting ? 'Yes' : 'No'}</span></div>\` : ''}
      \`;
      panel.classList.add('visible');
    }

    function closeNodeInfo() {
      document.getElementById('nodeInfoPanel').classList.remove('visible');
    }

    function updateGraphColors() {
      if (!cy) return;
      const colorBy = document.getElementById('colorBy').value;
      cy.nodes().forEach(node => {
        let color;
        if (colorBy === 'country') {
          color = countryColors[node.data('countryCode')] || '#6b7280';
        } else if (colorBy === 'cluster') {
          color = node.data('clusterId') ? '#ef4444' : '#10b981';
        } else {
          color = getScoreColor(node.data('score'));
        }
        node.style('background-color', color);
      });
    }

    function updateGraphSizes() {
      if (!cy) return;
      const sizeBy = document.getElementById('sizeBy').value;
      cy.nodes().forEach(node => {
        let size;
        if (sizeBy === 'betweenness') {
          size = Math.max(15, Math.min(60, 15 + (node.data('betweenness') || 0) * 200));
        } else if (sizeBy === 'score') {
          size = Math.max(15, Math.min(50, 15 + (node.data('score') || 0) * 35));
        } else {
          size = Math.max(15, Math.min(50, 10 + (node.data('degree') || 0) * 0.5));
        }
        node.style({ width: size, height: size });
      });
    }

    function resetView() { if (cy) cy.fit(); }
    function runLayout() {
      if (cy) cy.layout({ name: 'fcose', quality: 'proof', randomize: true, animate: true, animationDuration: 1000 }).run();
    }

    function switchTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById(tabId).classList.add('active');
      if (tabId === 'globe') initGlobe();
      if (tabId === 'graph') initGraph();
      if (tabId === 'overview') initCharts();
    }

    function toggleTheme() {
      document.body.classList.toggle('light-theme');
      localStorage.setItem('theme', document.body.classList.contains('light-theme') ? 'light' : 'dark');
    }
    if (localStorage.getItem('theme') === 'light') document.body.classList.add('light-theme');

    let chartsInitialized = false;
    function initCharts() {
      if (chartsInitialized) return;
      chartsInitialized = true;

      new Chart(document.getElementById('riskChart'), {
        type: 'doughnut',
        data: {
          labels: ['High', 'Medium', 'Low'],
          datasets: [{ data: [${report.highCentralization}, ${report.mediumCentralization}, ${report.lowCentralization}], backgroundColor: ['#ef4444', '#f59e0b', '#10b981'] }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
      });

      const countryData = ${JSON.stringify(report.infrastructureImpact.countryDistribution.slice(0, 10))};
      new Chart(document.getElementById('geoChart'), {
        type: 'bar',
        data: { labels: countryData.map(c => c.country), datasets: [{ label: 'Nodes', data: countryData.map(c => c.count), backgroundColor: '#3b82f6' }] },
        options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } } }
      });

      const providerData = ${JSON.stringify(report.infrastructureImpact.topProviders.slice(0, 10))};
      new Chart(document.getElementById('providerChart'), {
        type: 'bar',
        data: { labels: providerData.map(p => p.name.substring(0, 20)), datasets: [{ label: 'Nodes', data: providerData.map(p => p.count), backgroundColor: '#f59e0b' }] },
        options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } } }
      });

      new Chart(document.getElementById('peerChart'), {
        type: 'bar',
        data: { labels: ['0-20', '21-50', '51-100', '101-200', '200+'], datasets: [{ label: 'Nodes', data: ${JSON.stringify(getPeerDistribution(nodes))}, backgroundColor: '#10b981' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
    }

    function filterAllNodes(query) {
      const rows = document.querySelectorAll('#allNodesTable tbody tr');
      query = query.toLowerCase();
      rows.forEach(row => {
        row.style.display = row.getAttribute('data-search').includes(query) ? '' : 'none';
      });
    }

    function downloadFile(filename) {
      const link = document.createElement('a');
      link.href = filename;
      link.download = filename;
      link.click();
    }

    // Initialize globe on load
    initGlobe();
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getPeerDistribution(nodes: ArweaveNodeAnalysis[]): number[] {
  const ranges = [0, 0, 0, 0, 0];
  for (const node of nodes) {
    const peers = node.peers || 0;
    if (peers <= 20) ranges[0]++;
    else if (peers <= 50) ranges[1]++;
    else if (peers <= 100) ranges[2]++;
    else if (peers <= 200) ranges[3]++;
    else ranges[4]++;
  }
  return ranges;
}
