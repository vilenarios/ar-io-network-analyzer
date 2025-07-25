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
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: var(--card-bg);
            padding: 24px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        }

        .stat-card h3 {
            font-size: 0.875rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 8px;
        }

        .stat-card .value {
            font-size: 2rem;
            font-weight: 700;
            color: var(--text-color);
        }

        .stat-card .subtitle {
            font-size: 0.875rem;
            color: var(--text-muted);
            margin-top: 4px;
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
                <div class="subtitle">Active in network</div>
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
                <div class="value">${Math.round(summary.economicImpact.totalDistributedRewards / 1e6).toLocaleString()}</div>
                <div class="subtitle">Total ARIO this epoch</div>
            </div>
            <div class="stat-card">
                <h3>To Centralized Entities</h3>
                <div class="value">${Math.round(summary.economicImpact.topCentralizedRewards / 1e6).toLocaleString()}</div>
                <div class="subtitle">${summary.economicImpact.topCentralizedPercentage.toFixed(1)}% of total</div>
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

        // Top domains chart
        const topDomains = {};
        ${JSON.stringify(csvData)}.forEach(gw => {
            topDomains[gw.baseDomain] = (topDomains[gw.baseDomain] || 0) + 1;
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
        }

        function downloadFile(filename) {
            // Create a download link
            const link = document.createElement('a');
            link.href = filename;
            link.download = filename;
            link.click();
        }
    </script>
</body>
</html>`;

  return html;
}