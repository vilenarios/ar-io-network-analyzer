/**
 * HTML report generation utilities
 */

import type { CentralizationReport, GatewayAnalysis } from '../types.js';

export function generateHTMLReport(
  summary: CentralizationReport,
  csvData: GatewayAnalysis[],
  csvFilename: string,
  jsonFilename: string
): string {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AR.IO Gateway Centralization Analysis Report</title>
    <script src="https://code.jquery.com/jquery-3.7.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script src="https://unpkg.com/globe.gl"></script>
    <style>
        :root {
            --primary-color: #4F46E5;
            --secondary-color: #7C3AED;
            --success-color: #10B981;
            --warning-color: #F59E0B;
            --danger-color: #EF4444;
            --bg-color: #F9FAFB;
            --card-bg: #FFFFFF;
            --text-color: #1F2937;
            --text-muted: #6B7280;
            --border-color: #E5E7EB;
        }

        [data-theme="dark"] {
            --bg-color: #111827;
            --card-bg: #1F2937;
            --text-color: #F9FAFB;
            --text-muted: #D1D5DB;
            --border-color: #374151;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            line-height: 1.6;
            transition: all 0.3s ease;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid var(--border-color);
        }

        .header h1 {
            font-size: 2.5rem;
            background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .theme-toggle {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .theme-toggle:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: var(--card-bg);
            padding: 16px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        }

        .stat-card h3 {
            font-size: 0.75rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 6px;
        }

        .stat-card .value {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--text-color);
        }

        .stat-card .subtitle {
            font-size: 0.75rem;
            color: var(--text-muted);
            margin-top: 4px;
        }

        .status-breakdown {
            display: flex;
            gap: 12px;
            margin-top: 8px;
            font-size: 0.75rem;
        }

        .status-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .status-badge {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
        }

        .status-badge.joined {
            background-color: #10B981;
        }

        .status-badge.leaving {
            background-color: #F59E0B;
        }

        .charts-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .chart-card {
            background: var(--card-bg);
            padding: 24px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .chart-card h2 {
            font-size: 1.25rem;
            margin-bottom: 20px;
            color: var(--text-color);
        }

        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid var(--border-color);
        }

        .tab {
            padding: 12px 24px;
            background: none;
            border: none;
            font-size: 1rem;
            font-weight: 500;
            color: var(--text-muted);
            cursor: pointer;
            transition: all 0.3s ease;
            position: relative;
        }

        .tab.active {
            color: var(--primary-color);
        }

        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: var(--primary-color);
        }

        .tab-content {
            display: none;
            background: var(--card-bg);
            padding: 24px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .tab-content.active {
            display: block;
        }

        .search-box {
            margin-bottom: 20px;
            position: relative;
        }

        .search-box input {
            width: 100%;
            padding: 12px 16px 12px 40px;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            font-size: 1rem;
            background: var(--card-bg);
            color: var(--text-color);
        }

        .search-box::before {
            content: '🔍';
            position: absolute;
            left: 12px;
            top: 50%;
            transform: translateY(-50%);
        }

        .filters {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .filter-btn {
            padding: 8px 16px;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            background: var(--card-bg);
            color: var(--text-color);
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .filter-btn.active {
            background: var(--primary-color);
            color: white;
            border-color: var(--primary-color);
        }

        .data-table {
            width: 100%;
            border-collapse: collapse;
        }

        .data-table th,
        .data-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }

        .data-table th {
            font-weight: 600;
            color: var(--text-muted);
            background: var(--bg-color);
        }

        .data-table tr:hover {
            background: var(--bg-color);
        }

        .score-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.875rem;
            font-weight: 500;
        }

        .score-high {
            background: #FEE2E2;
            color: #991B1B;
        }

        .score-medium {
            background: #FEF3C7;
            color: #92400E;
        }

        .score-low {
            background: #D1FAE5;
            color: #065F46;
        }

        [data-theme="dark"] .score-high {
            background: #991B1B;
            color: #FEE2E2;
        }

        [data-theme="dark"] .score-medium {
            background: #92400E;
            color: #FEF3C7;
        }

        [data-theme="dark"] .score-low {
            background: #065F46;
            color: #D1FAE5;
        }

        .reason-chip {
            display: inline-block;
            padding: 2px 8px;
            margin: 2px;
            border-radius: 12px;
            font-size: 0.75rem;
            background: var(--bg-color);
            color: var(--text-muted);
        }

        .cluster-details {
            margin-top: 20px;
            padding: 24px;
            background: var(--bg-color);
            border-radius: 12px;
            border: 1px solid var(--border-color);
            overflow: hidden;
        }
        
        .cluster-details h3 {
            margin-bottom: 16px;
            color: var(--primary-color);
            font-size: 1.25rem;
        }
        
        .cluster-details p {
            margin: 8px 0;
            line-height: 1.6;
        }
        
        .cluster-details strong {
            color: var(--text-color);
            font-weight: 600;
        }
        
        .gateway-list {
            margin-top: 16px;
            padding: 16px;
            background: var(--card-bg);
            border-radius: 8px;
            max-height: 300px;
            overflow-y: auto;
            border: 1px solid var(--border-color);
        }
        
        .gateway-list ul {
            list-style: none;
            padding: 0;
            margin: 0;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 8px;
        }
        
        .gateway-list li {
            padding: 8px 12px;
            background: var(--bg-color);
            border-radius: 4px;
            font-family: monospace;
            font-size: 0.875rem;
            border: 1px solid var(--border-color);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .cluster-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 16px;
        }
        
        .cluster-stat {
            background: var(--card-bg);
            padding: 12px 16px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
        }
        
        .cluster-stat-label {
            font-size: 0.875rem;
            color: var(--text-muted);
            margin-bottom: 4px;
        }
        
        .cluster-stat-value {
            font-size: 1.125rem;
            font-weight: 600;
            color: var(--text-color);
        }

        .export-buttons {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }

        .export-btn {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .export-btn.primary {
            background: var(--primary-color);
            color: white;
        }

        .export-btn.secondary {
            background: var(--card-bg);
            color: var(--text-color);
            border: 1px solid var(--border-color);
        }

        .timestamp {
            color: var(--text-muted);
            font-size: 0.875rem;
            margin-top: 30px;
            text-align: center;
        }

        /* Globe visualization styles */
        .globe-container {
            position: relative;
            width: 100%;
            height: 700px;
            background: var(--card-bg);
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            margin-bottom: 20px;
        }

        #globeViz {
            width: 100%;
            height: 100%;
        }

        .globe-controls {
            position: absolute;
            top: 20px;
            left: 20px;
            z-index: 100;
            background: var(--card-bg);
            padding: 16px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            min-width: 200px;
        }

        .globe-controls h3 {
            font-size: 1rem;
            margin-bottom: 12px;
            color: var(--text-color);
        }

        .globe-control-item {
            margin-bottom: 12px;
        }

        .globe-control-item label {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.875rem;
            color: var(--text-color);
            cursor: pointer;
        }

        .globe-control-item input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
        }

        .globe-legend {
            position: absolute;
            bottom: 20px;
            right: 20px;
            z-index: 100;
            background: var(--card-bg);
            padding: 16px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }

        .globe-legend h4 {
            font-size: 0.875rem;
            margin-bottom: 8px;
            color: var(--text-color);
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
            font-size: 0.75rem;
            color: var(--text-muted);
        }

        .legend-color {
            width: 16px;
            height: 16px;
            border-radius: 50%;
        }

        .globe-info {
            position: absolute;
            top: 20px;
            right: 20px;
            z-index: 100;
            background: var(--card-bg);
            padding: 16px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            max-width: 300px;
            display: none;
        }

        .globe-info.visible {
            display: block;
        }

        .globe-info h3 {
            font-size: 1rem;
            margin-bottom: 8px;
            color: var(--text-color);
            word-break: break-all;
        }

        .globe-info p {
            font-size: 0.875rem;
            margin: 4px 0;
            color: var(--text-muted);
        }

        .globe-info .close-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: none;
            border: none;
            font-size: 1.25rem;
            cursor: pointer;
            color: var(--text-muted);
        }

        @media (max-width: 768px) {
            .header {
                flex-direction: column;
                gap: 20px;
            }

            .header h1 {
                font-size: 2rem;
            }

            .charts-grid {
                grid-template-columns: 1fr;
            }

            .filters {
                flex-direction: column;
            }

            .globe-container {
                height: 500px;
            }

            .globe-controls {
                left: 10px;
                top: 10px;
                padding: 12px;
                min-width: 150px;
            }

            .globe-legend {
                bottom: 10px;
                right: 10px;
                padding: 12px;
            }

            .globe-info {
                top: 10px;
                right: 10px;
                max-width: 200px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>AR.IO Gateway Centralization Analysis</h1>
            <button class="theme-toggle" onclick="toggleTheme()">🌓 Toggle Theme</button>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <h3>Total Gateways</h3>
                <div class="value">${summary.totalGateways}</div>
                <div class="subtitle">of ${summary.totalGatewaysInNetwork} total in network</div>
            </div>
            <div class="stat-card">
                <h3>Clustered Gateways</h3>
                <div class="value">${summary.clusteredGateways}</div>
                <div class="subtitle">${((summary.clusteredGateways / summary.totalGateways) * 100).toFixed(1)}% of total</div>
            </div>
            <div class="stat-card">
                <h3>High Centralization</h3>
                <div class="value">${summary.highCentralization}</div>
                <div class="subtitle">Score > 0.7</div>
            </div>
            <div class="stat-card">
                <h3>Detected Clusters</h3>
                <div class="value">${summary.clusters.length}</div>
                <div class="subtitle">Unique groups</div>
            </div>
            ${summary.economicImpact ? `
            <div class="stat-card">
                <h3>Epoch Rewards</h3>
                <div class="value">${Math.round(summary.economicImpact.totalDistributedRewards / 1e6).toLocaleString()} $ARIO</div>
                <div class="subtitle">Total this epoch</div>
            </div>
            <div class="stat-card">
                <h3>To Centralized Entities</h3>
                <div class="value">${Math.round(summary.economicImpact.topCentralizedRewards / 1e6).toLocaleString()} $ARIO</div>
                <div class="subtitle">${summary.economicImpact.topCentralizedPercentage.toFixed(1)}% of total</div>
            </div>
            ` : ''}
            ${summary.infrastructureImpact && summary.infrastructureImpact.uniqueIsps > 0 ? `
            <div class="stat-card">
                <h3>Unique TLDs</h3>
                <div class="value">${(() => {
                    const tlds = new Set();
                    csvData.forEach(gw => {
                        if (gw.baseDomain) {
                            const tld = gw.baseDomain.substring(gw.baseDomain.lastIndexOf('.'));
                            tlds.add(tld);
                        }
                    });
                    return tlds.size;
                })()}</div>
                <div class="subtitle">ArNS resilience across TLDs</div>
            </div>
            <div class="stat-card">
                <h3>Avg Response Time</h3>
                <div class="value">${(() => {
                    const responseTimes = csvData
                        .map(gw => gw.responseTime)
                        .filter(rt => rt && rt > 0);
                    if (responseTimes.length === 0) return 'N/A';
                    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
                    return Math.round(avg) + 'ms';
                })()}</div>
                <div class="subtitle">Gateway performance metric</div>
            </div>
            <div class="stat-card">
                <h3>Top Country</h3>
                <div class="value">${summary.infrastructureImpact.countryDistribution[0]?.country || 'N/A'}</div>
                <div class="subtitle">${summary.infrastructureImpact.countryDistribution[0]?.count || 0} gateways (${summary.infrastructureImpact.countryDistribution[0]?.percentage.toFixed(1) || '0'}%)</div>
            </div>
            <div class="stat-card">
                <h3>Datacenter Hosted</h3>
                <div class="value">${summary.infrastructureImpact.datacenterPercentage.toFixed(1)}%</div>
                <div class="subtitle">${summary.infrastructureImpact.totalDatacenterHosted} of ${summary.totalGateways} gateways</div>
            </div>
            <div class="stat-card">
                <h3>Top Hosting Provider</h3>
                <div class="value">${summary.infrastructureImpact.topProviders[0]?.name || 'N/A'}</div>
                <div class="subtitle">${summary.infrastructureImpact.topProviders[0]?.count || 0} gateways (${summary.infrastructureImpact.topProviders[0]?.percentage.toFixed(1) || '0'}%)</div>
            </div>
            ` : ''}
        </div>

        <div class="charts-grid">
            <div class="chart-card">
                <h2>Centralization Distribution</h2>
                <div style="height: 300px;">
                    <canvas id="distributionChart"></canvas>
                </div>
            </div>
            <div class="chart-card">
                <h2>Top Centralized Domains</h2>
                <div style="height: 300px;">
                    <canvas id="domainsChart"></canvas>
                </div>
            </div>
        </div>

        <div class="tabs">
            <button class="tab active" onclick="switchTab('summary')">Summary Report</button>
            <button class="tab" onclick="switchTab('globe')">🌍 Globe View</button>
            ${summary.infrastructureImpact && summary.infrastructureImpact.uniqueIsps > 0 ? '<button class="tab" onclick="switchTab(\'infrastructure\')">🏢 Infrastructure</button>' : ''}
            <button class="tab" onclick="switchTab('detailed')">Detailed Analysis</button>
            <button class="tab" onclick="switchTab('clusters')">Cluster Analysis</button>
            ${summary.economicImpact ? '<button class="tab" onclick="switchTab(\'economic\')">Economic Impact</button>' : ''}
        </div>

        <div id="summary-content" class="tab-content active">
            <h2>Top 100 Suspicious Gateways</h2>
            <div class="search-box">
                <input type="text" id="summarySearch" placeholder="Search gateways..." onkeyup="filterSummaryTable()">
            </div>
            <div class="filters">
                <button class="filter-btn active" onclick="filterByScore('all')">All</button>
                <button class="filter-btn" onclick="filterByScore('high')">High Risk (>0.7)</button>
                <button class="filter-btn" onclick="filterByScore('medium')">Medium Risk (0.4-0.7)</button>
                <button class="filter-btn" onclick="filterByScore('low')">Low Risk (<0.4)</button>
            </div>
            <table id="summaryTable" class="data-table">
                <thead>
                    <tr>
                        <th>Rank</th>
                        <th>Gateway</th>
                        <th>Centralization Score</th>
                        <th>Risk Level</th>
                        <th>Suspicion Reasons</th>
                    </tr>
                </thead>
                <tbody>
                    ${summary.topSuspicious.map((gateway, index) => `
                        <tr data-score="${gateway.score}">
                            <td>${index + 1}</td>
                            <td>${gateway.fqdn}</td>
                            <td>${gateway.score.toFixed(3)}</td>
                            <td>
                                <span class="score-badge ${
                                    gateway.score > 0.7 ? 'score-high' : 
                                    gateway.score > 0.4 ? 'score-medium' : 
                                    'score-low'
                                }">
                                    ${gateway.score > 0.7 ? 'High' : gateway.score > 0.4 ? 'Medium' : 'Low'}
                                </span>
                            </td>
                            <td>
                                ${gateway.reasons.map(reason => 
                                    `<span class="reason-chip">${reason.replace(/_/g, ' ')}</span>`
                                ).join('')}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div id="globe-content" class="tab-content">
            <h2>Global Gateway Distribution</h2>
            <div class="globe-container">
                <div id="globeViz"></div>

                <div class="globe-controls">
                    <h3>Controls</h3>
                    <div class="globe-control-item">
                        <label>
                            <input type="checkbox" id="autoRotate" checked onchange="toggleAutoRotate()">
                            Auto-rotate
                        </label>
                    </div>
                    <div class="globe-control-item">
                        <label>
                            <input type="checkbox" id="showArcs" checked onchange="toggleArcs()">
                            Show cluster arcs
                        </label>
                    </div>
                    <div class="globe-control-item" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color);">
                        <strong style="font-size: 0.875rem; margin-bottom: 8px; display: block;">Color By:</strong>
                        <label style="margin-left: 8px;">
                            <input type="radio" name="colorMode" value="risk" checked onchange="updateGlobeColorMode()">
                            Risk Level
                        </label>
                    </div>
                    <div class="globe-control-item">
                        <label style="margin-left: 8px;">
                            <input type="radio" name="colorMode" value="provider" onchange="updateGlobeColorMode()">
                            Hosting Provider
                        </label>
                    </div>
                    <div class="globe-control-item" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color);">
                        <label>
                            <input type="checkbox" id="showLowRisk" checked onchange="updateGlobeFilters()">
                            Show low risk
                        </label>
                    </div>
                    <div class="globe-control-item">
                        <label>
                            <input type="checkbox" id="showMediumRisk" checked onchange="updateGlobeFilters()">
                            Show medium risk
                        </label>
                    </div>
                    <div class="globe-control-item">
                        <label>
                            <input type="checkbox" id="showHighRisk" checked onchange="updateGlobeFilters()">
                            Show high risk
                        </label>
                    </div>
                </div>

                <div class="globe-legend">
                    <h4 id="globeLegendTitle">Risk Levels</h4>
                    <div id="globeLegendContent">
                        <div class="legend-item">
                            <div class="legend-color" style="background: #10B981;"></div>
                            <span>Low (0.0-0.4)</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color" style="background: #F59E0B;"></div>
                            <span>Medium (0.4-0.7)</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color" style="background: #EF4444;"></div>
                            <span>High (0.7-1.0)</span>
                        </div>
                    </div>
                </div>

                <div id="globeInfo" class="globe-info">
                    <button class="close-btn" onclick="closeGlobeInfo()">×</button>
                    <h3 id="globeInfoTitle"></h3>
                    <p><strong>Score:</strong> <span id="globeInfoScore"></span></p>
                    <p><strong>Location:</strong> <span id="globeInfoLocation"></span></p>
                    <p><strong>ISP:</strong> <span id="globeInfoIsp"></span></p>
                    <p><strong>Datacenter:</strong> <span id="globeInfoDatacenter"></span></p>
                    <p><strong>Stake:</strong> <span id="globeInfoStake"></span></p>
                    <p><strong>Cluster:</strong> <span id="globeInfoCluster"></span></p>
                </div>
            </div>
            <p style="color: var(--text-muted); font-size: 0.875rem; margin-top: 12px;">
                Showing ${csvData.filter(g => g.latitude && g.longitude).length} gateways with geographic data.
                Point size represents stake amount. Click any point for details.
            </p>
        </div>

        ${summary.infrastructureImpact && summary.infrastructureImpact.uniqueIsps > 0 ? `
        <div id="infrastructure-content" class="tab-content">
            <h2>Infrastructure Analysis</h2>

            <!-- Quick Stats -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 30px;">
                <div class="stat-card">
                    <h3>Datacenter Hosted</h3>
                    <div class="value">${summary.infrastructureImpact.datacenterPercentage.toFixed(1)}%</div>
                    <div class="subtitle">${summary.infrastructureImpact.totalDatacenterHosted} gateways</div>
                </div>
                <div class="stat-card">
                    <h3>Top Provider</h3>
                    <div class="value">${summary.infrastructureImpact.topProviders[0]?.name || 'N/A'}</div>
                    <div class="subtitle">${summary.infrastructureImpact.topProviders[0]?.count || 0} gateways</div>
                </div>
                <div class="stat-card">
                    <h3>Countries</h3>
                    <div class="value">${summary.infrastructureImpact.uniqueCountries}</div>
                    <div class="subtitle">Geographic distribution</div>
                </div>
                <div class="stat-card">
                    <h3>Unique ISPs</h3>
                    <div class="value">${summary.infrastructureImpact.uniqueIsps}</div>
                    <div class="subtitle">Service providers</div>
                </div>
                <div class="stat-card">
                    <h3>Unique TLDs</h3>
                    <div class="value" id="uniqueTldCount">-</div>
                    <div class="subtitle">Domain diversity</div>
                </div>
            </div>

            <!-- Charts Grid -->
            <div class="charts-grid">
                <div class="chart-card">
                    <h2>Hosting Type Distribution</h2>
                    <div style="height: 300px;">
                        <canvas id="hostingTypeChart"></canvas>
                    </div>
                </div>
                <div class="chart-card">
                    <h2>Top 10 Hosting Providers</h2>
                    <div style="height: 300px;">
                        <canvas id="providersChart"></canvas>
                    </div>
                </div>
            </div>

            <!-- Domain Diversity Section -->
            <div style="margin-top: 30px;">
                <h3 style="margin-bottom: 16px;">Domain Diversity (ArNS Resilience)</h3>
                <div class="chart-card">
                    <h2>Top-Level Domain Distribution</h2>
                    <p style="color: var(--text-muted); font-size: 0.875rem; margin-bottom: 16px;">
                        ArNS names resolve through all gateway domains. More TLDs = greater resilience against domain seizures.
                    </p>
                    <div style="height: 400px;">
                        <canvas id="tldChart"></canvas>
                    </div>
                </div>
            </div>

            <!-- ISP Distribution Table -->
            <div style="margin-top: 30px;">
                <h3 style="margin-bottom: 16px;">ISP/Hosting Provider Distribution</h3>
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Provider</th>
                            <th>Gateway Count</th>
                            <th>Percentage</th>
                            <th>Type</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${summary.infrastructureImpact.topProviders.slice(0, 20).map((provider, index) => {
                            // Determine if it's a datacenter (check first gateway from this provider)
                            const sampleGateway = csvData.find(g => g.isp === provider.name);
                            const isDatacenter = sampleGateway?.hosting === true;
                            return `
                            <tr>
                                <td>${index + 1}</td>
                                <td>${provider.name}</td>
                                <td>${provider.count}</td>
                                <td>
                                    <span class="score-badge ${
                                        provider.percentage > 10 ? 'score-high' :
                                        provider.percentage > 5 ? 'score-medium' :
                                        'score-low'
                                    }">
                                        ${provider.percentage.toFixed(2)}%
                                    </span>
                                </td>
                                <td>${isDatacenter ? '🏢 Datacenter' : '🏠 Other'}</td>
                            </tr>
                        `}).join('')}
                    </tbody>
                </table>
            </div>

            <!-- Country Distribution Table -->
            <div style="margin-top: 30px;">
                <h3 style="margin-bottom: 16px;">Geographic Distribution by Country</h3>
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Country</th>
                            <th>Code</th>
                            <th>Gateway Count</th>
                            <th>Percentage</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${summary.infrastructureImpact.countryDistribution.slice(0, 20).map((country, index) => `
                            <tr>
                                <td>${index + 1}</td>
                                <td>${country.country}</td>
                                <td>${country.countryCode}</td>
                                <td>${country.count}</td>
                                <td>
                                    <span class="score-badge ${
                                        country.percentage > 20 ? 'score-high' :
                                        country.percentage > 10 ? 'score-medium' :
                                        'score-low'
                                    }">
                                        ${country.percentage.toFixed(2)}%
                                    </span>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        ` : ''}

        <div id="detailed-content" class="tab-content">
            <h2>All Gateway Analysis</h2>
            <div class="search-box">
                <input type="text" id="detailedSearch" placeholder="Search all gateways..." onkeyup="filterDetailedTable()">
            </div>
            <table id="detailedTable" class="data-table">
                <thead>
                    <tr>
                        <th>Gateway</th>
                        <th>Wallet</th>
                        <th>Stake</th>
                        <th>Domain</th>
                        <th>Pattern</th>
                        <th>IP Range</th>
                        <th>Cluster</th>
                        <th>Overall Score</th>
                    </tr>
                </thead>
                <tbody>
                    ${csvData.map(gateway => `
                        <tr>
                            <td>${gateway.fqdn}</td>
                            <td>${gateway.wallet.substring(0, 8)}...</td>
                            <td>${gateway.stake.toLocaleString()}</td>
                            <td>${gateway.baseDomain}</td>
                            <td>${gateway.domainPattern}</td>
                            <td>${gateway.ipRange}</td>
                            <td>${gateway.clusterId || '-'}</td>
                            <td>
                                <span class="score-badge ${
                                    gateway.overallCentralization > 0.7 ? 'score-high' : 
                                    gateway.overallCentralization > 0.4 ? 'score-medium' : 
                                    'score-low'
                                }">
                                    ${gateway.overallCentralization.toFixed(3)}
                                </span>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div id="clusters-content" class="tab-content">
            <h2>Cluster Analysis</h2>
            ${summary.clusters.map((cluster, idx) => `
                <div class="cluster-details">
                    <h3>#${idx + 1}: ${cluster.baseDomain} Cluster</h3>
                    <div class="cluster-stats">
                        <div class="cluster-stat">
                            <div class="cluster-stat-label">Cluster ID</div>
                            <div class="cluster-stat-value">${cluster.id}</div>
                        </div>
                        <div class="cluster-stat">
                            <div class="cluster-stat-label">Pattern</div>
                            <div class="cluster-stat-value">${cluster.pattern.replace(/_/g, ' ')}</div>
                        </div>
                        <div class="cluster-stat">
                            <div class="cluster-stat-label">Gateway Count</div>
                            <div class="cluster-stat-value">${cluster.size}</div>
                        </div>
                        <div class="cluster-stat">
                            <div class="cluster-stat-label">Avg Score</div>
                            <div class="cluster-stat-value">
                                <span class="score-badge ${
                                    cluster.avgScore > 0.7 ? 'score-high' : 
                                    cluster.avgScore > 0.4 ? 'score-medium' : 
                                    'score-low'
                                }">
                                    ${cluster.avgScore.toFixed(3)}
                                </span>
                            </div>
                        </div>
                        ${cluster.totalRewards ? `
                        <div class="cluster-stat">
                            <div class="cluster-stat-label">Est. ARIO Rewards</div>
                            <div class="cluster-stat-value">${Math.round(cluster.totalRewards / 1e6).toLocaleString()}</div>
                        </div>
                        ` : ''}
                    </div>
                    <div class="gateway-list">
                        <p style="margin-top: 0; font-weight: 600;">Gateway URLs:</p>
                        <ul>
                            ${cluster.gateways.map(gw => `<li title="${gw}">${gw}</li>`).join('')}
                        </ul>
                    </div>
                </div>
            `).join('')}
        </div>

        ${summary.economicImpact ? `
        <div id="economic-content" class="tab-content">
            <h2>Economic Impact Analysis (Estimated)</h2>
            <div class="economic-summary">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px;">
                    <div class="stat-card">
                        <h3>Total Rewards This Epoch</h3>
                        <div class="value">${Math.round(summary.economicImpact.totalDistributedRewards / 1e6).toLocaleString()} ARIO</div>
                        <div class="subtitle">Sum of all gateway rewards (${summary.totalGateways} × ${Math.round(summary.economicImpact.rewardPerGateway / 1e6)} ARIO)</div>
                    </div>
                    <div class="stat-card">
                        <h3>Per Gateway Reward</h3>
                        <div class="value">${Math.round(summary.economicImpact.rewardPerGateway / 1e6).toLocaleString()} ARIO</div>
                        <div class="subtitle">Each gateway's eligible reward this epoch</div>
                    </div>
                </div>
                
                <h3 style="margin: 20px 0;">Estimated Rewards by Centralized Clusters</h3>
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Cluster</th>
                            <th>Base Domain</th>
                            <th>Gateways</th>
                            <th>Cluster Total (ARIO)</th>
                            <th>% of Pool</th>
                            <th>Impact</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${summary.economicImpact.rewardsByCluster.map((cluster, index) => {
                            const clusterInfo = summary.clusters.find(c => c.id === cluster.clusterId);
                            return `
                            <tr>
                                <td>${index + 1}</td>
                                <td>${cluster.clusterId}</td>
                                <td>${clusterInfo?.baseDomain || '-'}</td>
                                <td>${cluster.gatewayCount}</td>
                                <td>${Math.round(cluster.clusterRewards / 1e6).toLocaleString()}</td>
                                <td>
                                    <span class="score-badge ${
                                        cluster.percentageOfTotal > 5 ? 'score-high' : 
                                        cluster.percentageOfTotal > 2 ? 'score-medium' : 
                                        'score-low'
                                    }">
                                        ${cluster.percentageOfTotal.toFixed(2)}%
                                    </span>
                                </td>
                                <td>
                                    ${cluster.percentageOfTotal > 5 ? '🔴 High' : 
                                      cluster.percentageOfTotal > 2 ? '🟡 Medium' : 
                                      '🟢 Low'}
                                </td>
                            </tr>
                        `}).join('')}
                    </tbody>
                </table>
                
                <div class="cluster-details" style="margin-top: 30px;">
                    <h3>Summary Statistics</h3>
                    <p><strong>Total ARIO going to centralized clusters:</strong> ${Math.round(summary.economicImpact.topCentralizedRewards / 1e6).toLocaleString()} ARIO</p>
                    <p><strong>Percentage of total pool:</strong> ${summary.economicImpact.topCentralizedPercentage.toFixed(2)}%</p>
                    <p><strong>Number of centralized clusters receiving rewards:</strong> ${summary.economicImpact.rewardsByCluster.length}</p>
                    <p style="color: var(--text-muted); font-style: italic;">Note: Based on eligible rewards of ${Math.round(summary.economicImpact.rewardPerGateway / 1e6).toLocaleString()} ARIO per gateway</p>
                </div>
            </div>
        </div>
        ` : ''}

        ${process.env.SKIP_GEO ? '' : `
        <div style="background: var(--bg-color); padding: 16px; border-radius: 8px; margin-top: 20px; font-size: 0.875rem; color: var(--text-muted);">
            <strong>Note:</strong> Geographic data may be incomplete due to API rate limits. For best results, run with smaller gateway sets or use SKIP_GEO=true to disable geographic analysis.
        </div>
        `}

        <div class="export-buttons">
            <button class="export-btn primary" onclick="downloadFile('${csvFilename}')">📥 Download CSV</button>
            <button class="export-btn primary" onclick="downloadFile('${jsonFilename}')">📥 Download JSON</button>
            <button class="export-btn secondary" onclick="window.print()">🖨️ Print Report</button>
        </div>

        <div class="timestamp">
            Generated on ${new Date(summary.timestamp).toLocaleString()}
        </div>
    </div>

    <script>
        // Theme toggle
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            updateChartTheme();
        }

        // Load saved theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        // Tab switching
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName + '-content').classList.add('active');
        }

        // Filter functions
        function filterByScore(level) {
            const rows = document.querySelectorAll('#summaryTable tbody tr');
            document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            rows.forEach(row => {
                const score = parseFloat(row.getAttribute('data-score'));
                if (level === 'all') {
                    row.style.display = '';
                } else if (level === 'high' && score > 0.7) {
                    row.style.display = '';
                } else if (level === 'medium' && score > 0.4 && score <= 0.7) {
                    row.style.display = '';
                } else if (level === 'low' && score <= 0.4) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        }

        function filterSummaryTable() {
            const input = document.getElementById('summarySearch');
            const filter = input.value.toLowerCase();
            const rows = document.querySelectorAll('#summaryTable tbody tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(filter) ? '' : 'none';
            });
        }

        function filterDetailedTable() {
            const input = document.getElementById('detailedSearch');
            const filter = input.value.toLowerCase();
            const rows = document.querySelectorAll('#detailedTable tbody tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(filter) ? '' : 'none';
            });
        }

        // Chart setup
        const chartColors = {
            high: '#EF4444',
            medium: '#F59E0B',
            low: '#10B981'
        };

        // Distribution chart
        const distributionData = {
            high: ${summary.highCentralization},
            medium: ${summary.topSuspicious.filter(g => g.score > 0.4 && g.score <= 0.7).length},
            low: ${summary.totalGateways - summary.highCentralization - summary.topSuspicious.filter(g => g.score > 0.4 && g.score <= 0.7).length}
        };

        const distributionCtx = document.getElementById('distributionChart').getContext('2d');
        const distributionChart = new Chart(distributionCtx, {
            type: 'doughnut',
            data: {
                labels: ['High Risk', 'Medium Risk', 'Low Risk'],
                datasets: [{
                    data: [distributionData.high, distributionData.medium, distributionData.low],
                    backgroundColor: [chartColors.high, chartColors.medium, chartColors.low],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 20,
                            font: {
                                size: 14
                            }
                        }
                    }
                }
            }
        });

        // Top centralized domains chart - only domains with domain-based clusters
        const topDomains = {};
        ${JSON.stringify(csvData)}.forEach(gw => {
            // Only count gateways that are in domain-based clusters (not ip- or pattern- clusters)
            if (gw.clusterId && gw.clusterId.startsWith('domain-')) {
                topDomains[gw.baseDomain] = (topDomains[gw.baseDomain] || 0) + 1;
            }
        });

        const sortedDomains = Object.entries(topDomains)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const domainsCtx = document.getElementById('domainsChart').getContext('2d');
        const domainsChart = new Chart(domainsCtx, {
            type: 'bar',
            data: {
                labels: sortedDomains.map(d => d[0]),
                datasets: [{
                    label: 'Gateway Count',
                    data: sortedDomains.map(d => d[1]),
                    backgroundColor: '#4F46E5',
                    borderWidth: 0,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true
                    }
                }
            }
        });

        // Infrastructure charts
        let hostingTypeChart, providersChart, tldChart;
        ${summary.infrastructureImpact && summary.infrastructureImpact.uniqueIsps > 0 ? `
        const infrastructureData = ${JSON.stringify(summary.infrastructureImpact)};

        // Hosting Type Pie Chart
        const hostingTypeCtx = document.getElementById('hostingTypeChart')?.getContext('2d');
        if (hostingTypeCtx) {
            const nonDatacenter = ${summary.totalGateways} - infrastructureData.totalDatacenterHosted;
            hostingTypeChart = new Chart(hostingTypeCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Datacenter', 'Non-Datacenter'],
                    datasets: [{
                        data: [infrastructureData.totalDatacenterHosted, nonDatacenter],
                        backgroundColor: ['#F59E0B', '#10B981'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                padding: 20,
                                font: { size: 14 }
                            }
                        }
                    }
                }
            });
        }

        // Top Providers Bar Chart
        const providersCtx = document.getElementById('providersChart')?.getContext('2d');
        if (providersCtx) {
            const top10Providers = infrastructureData.topProviders.slice(0, 10);
            providersChart = new Chart(providersCtx, {
                type: 'bar',
                data: {
                    labels: top10Providers.map(p => p.name),
                    datasets: [{
                        label: 'Gateway Count',
                        data: top10Providers.map(p => p.count),
                        backgroundColor: '#4F46E5',
                        borderWidth: 0,
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: 'y',
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: { beginAtZero: true }
                    }
                }
            });
        }

        // TLD Distribution Chart
        const tldCtx = document.getElementById('tldChart')?.getContext('2d');
        if (tldCtx) {
            // Calculate TLD distribution from gateway data
            const gateways = ${JSON.stringify(csvData)};
            const tldCounts = {};

            gateways.forEach(g => {
                if (g.baseDomain) {
                    // Extract TLD from base domain (e.g., "vnar.xyz" -> ".xyz")
                    const tld = g.baseDomain.substring(g.baseDomain.lastIndexOf('.'));
                    tldCounts[tld] = (tldCounts[tld] || 0) + 1;
                }
            });

            // Sort by count and get top TLDs
            const sortedTlds = Object.entries(tldCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 15); // Top 15 TLDs

            // Update unique TLD count
            document.getElementById('uniqueTldCount').textContent = Object.keys(tldCounts).length;

            // Generate colors for the chart
            const colors = [
                '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F59E0B',
                '#10B981', '#14B8A6', '#06B6D4', '#3B82F6', '#6366F1',
                '#8B5CF6', '#A855F7', '#D946EF', '#F43F5E', '#FB923C'
            ];

            tldChart = new Chart(tldCtx, {
                type: 'doughnut',
                data: {
                    labels: sortedTlds.map(([tld]) => tld),
                    datasets: [{
                        data: sortedTlds.map(([, count]) => count),
                        backgroundColor: colors,
                        borderWidth: 2,
                        borderColor: '#FFFFFF'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'right',
                            labels: {
                                padding: 15,
                                font: { size: 12 },
                                generateLabels: function(chart) {
                                    const data = chart.data;
                                    return data.labels.map((label, i) => ({
                                        text: \`\${label} (\${data.datasets[0].data[i]})\`,
                                        fillStyle: data.datasets[0].backgroundColor[i],
                                        hidden: false,
                                        index: i
                                    }));
                                }
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const percentage = ((context.parsed / total) * 100).toFixed(1);
                                    return \`\${context.label}: \${context.parsed} gateways (\${percentage}%)\`;
                                }
                            }
                        }
                    }
                }
            });
        }
        ` : ''}

        function updateChartTheme() {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const textColor = isDark ? '#F9FAFB' : '#1F2937';
            const gridColor = isDark ? '#374151' : '#E5E7EB';
            
            // Update distribution chart (doughnut - no scales)
            if (distributionChart && distributionChart.options.plugins.legend) {
                distributionChart.options.plugins.legend.labels.color = textColor;
                distributionChart.update();
            }
            
            // Update domains chart (bar - has scales)
            if (domainsChart) {
                if (domainsChart.options.plugins.legend) {
                    domainsChart.options.plugins.legend.labels.color = textColor;
                }
                if (domainsChart.options.scales) {
                    if (domainsChart.options.scales.x) {
                        domainsChart.options.scales.x.ticks = { ...domainsChart.options.scales.x.ticks, color: textColor };
                        domainsChart.options.scales.x.grid = { ...domainsChart.options.scales.x.grid, color: gridColor };
                    }
                    if (domainsChart.options.scales.y) {
                        domainsChart.options.scales.y.ticks = { ...domainsChart.options.scales.y.ticks, color: textColor };
                        domainsChart.options.scales.y.grid = { ...domainsChart.options.scales.y.grid, color: gridColor };
                    }
                }
                domainsChart.update();
            }

            // Update infrastructure charts
            if (hostingTypeChart && hostingTypeChart.options.plugins.legend) {
                hostingTypeChart.options.plugins.legend.labels.color = textColor;
                hostingTypeChart.update();
            }

            if (providersChart) {
                if (providersChart.options.plugins.legend) {
                    providersChart.options.plugins.legend.labels.color = textColor;
                }
                if (providersChart.options.scales) {
                    if (providersChart.options.scales.x) {
                        providersChart.options.scales.x.ticks = { ...providersChart.options.scales.x.ticks, color: textColor };
                        providersChart.options.scales.x.grid = { ...providersChart.options.scales.x.grid, color: gridColor };
                    }
                    if (providersChart.options.scales.y) {
                        providersChart.options.scales.y.ticks = { ...providersChart.options.scales.y.ticks, color: textColor };
                        providersChart.options.scales.y.grid = { ...providersChart.options.scales.y.grid, color: gridColor };
                    }
                }
                providersChart.update();
            }

            // Update TLD chart
            if (tldChart && tldChart.options.plugins.legend) {
                tldChart.options.plugins.legend.labels.color = textColor;
                tldChart.update();
            }
        }

        function downloadFile(filename) {
            // Create a download link
            const link = document.createElement('a');
            link.href = filename;
            link.download = filename;
            link.click();
        }

        // Globe visualization
        let myGlobe;
        let globeData = [];
        let globeArcs = [];
        let currentFilters = { low: true, medium: true, high: true };
        let colorMode = 'risk'; // 'risk' or 'provider'

        // Provider color mapping
        const providerColors = {
            'Hetzner': '#FF6B6B',
            'Amazon': '#FF9F40',
            'DigitalOcean': '#4ECDC4',
            'OVH': '#A29BFE',
            'Vultr': '#74B9FF',
            'Google': '#FD79A8',
            'Microsoft': '#A8E6CF',
            'Linode': '#FFD93D',
            'Contabo': '#95E1D3',
            'Datacenter': '#95A5A6',
            'Non-Datacenter': '#2ECC71',
            'Unknown': '#BDC3C7'
        };

        function getProviderColor(isp, hosting) {
            if (!isp || isp === 'N/A') return providerColors['Unknown'];

            // Check for known providers
            const ispLower = isp.toLowerCase();
            if (ispLower.includes('hetzner')) return providerColors['Hetzner'];
            if (ispLower.includes('amazon') || ispLower.includes('aws')) return providerColors['Amazon'];
            if (ispLower.includes('digitalocean')) return providerColors['DigitalOcean'];
            if (ispLower.includes('ovh')) return providerColors['OVH'];
            if (ispLower.includes('vultr')) return providerColors['Vultr'];
            if (ispLower.includes('google')) return providerColors['Google'];
            if (ispLower.includes('microsoft') || ispLower.includes('azure')) return providerColors['Microsoft'];
            if (ispLower.includes('linode')) return providerColors['Linode'];
            if (ispLower.includes('contabo')) return providerColors['Contabo'];

            // Fallback based on hosting flag
            return hosting ? providerColors['Datacenter'] : providerColors['Non-Datacenter'];
        }

        function initGlobe() {
            if (myGlobe) return; // Already initialized

            // Prepare gateway data for globe
            const gateways = ${JSON.stringify(csvData)};
            globeData = gateways
                .filter(g => g.latitude && g.longitude)
                .map(g => ({
                    lat: g.latitude,
                    lng: g.longitude,
                    fqdn: g.fqdn,
                    score: g.overallCentralization,
                    stake: g.stake,
                    city: g.city || 'Unknown',
                    country: g.country || 'Unknown',
                    isp: g.isp || 'Unknown',
                    hosting: g.hosting || false,
                    clusterId: g.clusterId,
                    riskLevel: g.overallCentralization > 0.7 ? 'high' :
                               g.overallCentralization > 0.4 ? 'medium' : 'low'
                }));

            // Generate arcs between gateways in the same cluster
            const clusters = {};
            globeData.forEach(g => {
                if (g.clusterId) {
                    if (!clusters[g.clusterId]) clusters[g.clusterId] = [];
                    clusters[g.clusterId].push(g);
                }
            });

            globeArcs = [];
            Object.values(clusters).forEach(clusterGateways => {
                if (clusterGateways.length > 1) {
                    // Connect first gateway to all others in cluster
                    const primary = clusterGateways[0];
                    for (let i = 1; i < clusterGateways.length; i++) {
                        const secondary = clusterGateways[i];
                        globeArcs.push({
                            startLat: primary.lat,
                            startLng: primary.lng,
                            endLat: secondary.lat,
                            endLng: secondary.lng,
                            clusterId: primary.clusterId,
                            score: Math.max(primary.score, secondary.score)
                        });
                    }
                }
            });

            // Initialize globe
            myGlobe = Globe()
                .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
                .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
                .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
                .pointsData(globeData)
                .pointLat('lat')
                .pointLng('lng')
                .pointColor(d => {
                    if (colorMode === 'provider') {
                        return getProviderColor(d.isp, d.hosting);
                    } else {
                        // Risk level colors
                        if (d.score > 0.7) return '#EF4444';
                        if (d.score > 0.4) return '#F59E0B';
                        return '#10B981';
                    }
                })
                .pointAltitude(d => {
                    // Higher altitude for higher stakes (normalized)
                    const maxStake = Math.max(...globeData.map(g => g.stake));
                    return 0.01 + (d.stake / maxStake) * 0.05;
                })
                .pointRadius(d => {
                    // Size based on stake
                    const maxStake = Math.max(...globeData.map(g => g.stake));
                    return 0.15 + (d.stake / maxStake) * 0.4;
                })
                .pointLabel(d => \`
                    <div style="background: rgba(0,0,0,0.8); padding: 8px; border-radius: 4px; color: white;">
                        <strong>\${d.fqdn}</strong><br/>
                        Score: \${d.score.toFixed(3)}<br/>
                        Location: \${d.city}, \${d.country}<br/>
                        ISP: \${d.isp}<br/>
                        Datacenter: \${d.hosting ? 'Yes' : 'No'}<br/>
                        Stake: \${d.stake.toLocaleString()}
                    </div>
                \`)
                .onPointClick(point => {
                    document.getElementById('globeInfoTitle').textContent = point.fqdn;
                    document.getElementById('globeInfoScore').innerHTML = \`
                        <span class="score-badge \${
                            point.score > 0.7 ? 'score-high' :
                            point.score > 0.4 ? 'score-medium' :
                            'score-low'
                        }">
                            \${point.score.toFixed(3)}
                        </span>
                    \`;
                    document.getElementById('globeInfoLocation').textContent = \`\${point.city}, \${point.country}\`;
                    document.getElementById('globeInfoIsp').textContent = point.isp || 'Unknown';
                    document.getElementById('globeInfoDatacenter').textContent = point.hosting ? 'Yes' : 'No';
                    document.getElementById('globeInfoStake').textContent = point.stake.toLocaleString();
                    document.getElementById('globeInfoCluster').textContent = point.clusterId || 'None';
                    document.getElementById('globeInfo').classList.add('visible');
                })
                .arcsData(globeArcs)
                .arcStartLat('startLat')
                .arcStartLng('startLng')
                .arcEndLat('endLat')
                .arcEndLng('endLng')
                .arcColor(d => {
                    if (d.score > 0.7) return 'rgba(239, 68, 68, 0.4)';
                    if (d.score > 0.4) return 'rgba(245, 158, 11, 0.4)';
                    return 'rgba(16, 185, 129, 0.4)';
                })
                .arcDashLength(0.4)
                .arcDashGap(0.2)
                .arcDashAnimateTime(2000)
                .arcStroke(0.5)
                (document.getElementById('globeViz'));

            // Set initial view
            myGlobe.pointOfView({ altitude: 2.5 });

            // Enable controls
            const controls = myGlobe.controls();
            controls.autoRotate = true;
            controls.autoRotateSpeed = 0.5;

            // Handle theme changes
            setTimeout(() => {
                if (document.documentElement.getAttribute('data-theme') === 'dark') {
                    myGlobe.globeImageUrl('https://unpkg.com/three-globe/example/img/earth-dark.jpg');
                }
            }, 100);
        }

        function toggleAutoRotate() {
            if (!myGlobe) return;
            const controls = myGlobe.controls();
            controls.autoRotate = document.getElementById('autoRotate').checked;
        }

        function toggleArcs() {
            if (!myGlobe) return;
            const showArcs = document.getElementById('showArcs').checked;
            myGlobe.arcsData(showArcs ? globeArcs : []);
        }

        function updateGlobeFilters() {
            if (!myGlobe) return;

            currentFilters.low = document.getElementById('showLowRisk').checked;
            currentFilters.medium = document.getElementById('showMediumRisk').checked;
            currentFilters.high = document.getElementById('showHighRisk').checked;

            const filteredData = globeData.filter(g => {
                if (g.riskLevel === 'low' && currentFilters.low) return true;
                if (g.riskLevel === 'medium' && currentFilters.medium) return true;
                if (g.riskLevel === 'high' && currentFilters.high) return true;
                return false;
            });

            myGlobe.pointsData(filteredData);
        }

        function updateGlobeColorMode() {
            if (!myGlobe) return;

            // Get selected color mode
            const selectedMode = document.querySelector('input[name="colorMode"]:checked').value;
            colorMode = selectedMode;

            // Update point colors
            myGlobe.pointColor(d => {
                if (colorMode === 'provider') {
                    return getProviderColor(d.isp, d.hosting);
                } else {
                    if (d.score > 0.7) return '#EF4444';
                    if (d.score > 0.4) return '#F59E0B';
                    return '#10B981';
                }
            });

            // Update legend
            updateGlobeLegend();
        }

        function updateGlobeLegend() {
            const title = document.getElementById('globeLegendTitle');
            const content = document.getElementById('globeLegendContent');

            if (colorMode === 'provider') {
                title.textContent = 'Hosting Providers';

                // Get unique providers from data
                const providerCounts = {};
                globeData.forEach(g => {
                    const color = getProviderColor(g.isp, g.hosting);
                    let providerName;
                    const ispLower = (g.isp || '').toLowerCase();

                    if (ispLower.includes('hetzner')) providerName = 'Hetzner';
                    else if (ispLower.includes('amazon') || ispLower.includes('aws')) providerName = 'Amazon';
                    else if (ispLower.includes('digitalocean')) providerName = 'DigitalOcean';
                    else if (ispLower.includes('ovh')) providerName = 'OVH';
                    else if (ispLower.includes('vultr')) providerName = 'Vultr';
                    else if (ispLower.includes('google')) providerName = 'Google';
                    else if (ispLower.includes('microsoft') || ispLower.includes('azure')) providerName = 'Microsoft';
                    else if (g.hosting) providerName = 'Other Datacenter';
                    else providerName = 'Non-Datacenter';

                    if (!providerCounts[providerName]) {
                        providerCounts[providerName] = { count: 0, color };
                    }
                    providerCounts[providerName].count++;
                });

                // Sort by count and take top 8
                const sortedProviders = Object.entries(providerCounts)
                    .sort((a, b) => b[1].count - a[1].count)
                    .slice(0, 8);

                content.innerHTML = sortedProviders.map(([name, data]) => \`
                    <div class="legend-item">
                        <div class="legend-color" style="background: \${data.color};"></div>
                        <span>\${name} (\${data.count})</span>
                    </div>
                \`).join('');
            } else {
                title.textContent = 'Risk Levels';
                content.innerHTML = \`
                    <div class="legend-item">
                        <div class="legend-color" style="background: #10B981;"></div>
                        <span>Low (0.0-0.4)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #F59E0B;"></div>
                        <span>Medium (0.4-0.7)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #EF4444;"></div>
                        <span>High (0.7-1.0)</span>
                    </div>
                \`;
            }
        }

        function closeGlobeInfo() {
            document.getElementById('globeInfo').classList.remove('visible');
        }

        // Original switchTab function - update to initialize globe when switching to it
        const originalSwitchTab = switchTab;
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

            event.target.classList.add('active');
            document.getElementById(tabName + '-content').classList.add('active');

            // Initialize globe when switching to globe tab
            if (tabName === 'globe') {
                setTimeout(() => initGlobe(), 100);
            }
        }
    </script>
</body>
</html>`;

  return html;
}