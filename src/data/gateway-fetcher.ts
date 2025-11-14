/**
 * Gateway data fetching utilities
 */

import type { Gateway, AnalyzerConfig } from '../types.js';

export async function fetchGatewaysFromNetwork(_config: AnalyzerConfig): Promise<{ gateways: Gateway[], totalFetched: number }> {
  try {
    // Dynamic import for AR.IO SDK
    const { ARIO } = await import('@ar.io/sdk');
    
    // Initialize ARIO for mainnet
    const ario = ARIO.mainnet();
    
    console.log('Fetching all gateways from AR.IO network...');
    
    // Fetch all gateways with pagination
    const gateways: Gateway[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let pageCount = 0;
    let totalFetched = 0;

    while (hasMore) {
      pageCount++;
      console.log(`Fetching page ${pageCount}${cursor ? ` (cursor: ${cursor.substring(0, 10)}...)` : ''}`);

      try {
        const response = await ario.getGateways({
          cursor,
          limit: 1000,
          sortOrder: 'desc',
          sortBy: 'operatorStake'
        });

        console.log(`  Fetched ${response.items.length} gateways`);
        totalFetched += response.items.length;
        
        for (const gateway of response.items) {
          // Only include joined gateways with valid FQDN
          if (gateway.status === 'joined' && gateway.settings?.fqdn) {
            gateways.push({
              fqdn: gateway.settings.fqdn,
              wallet: gateway.gatewayAddress,
              stake: gateway.operatorStake || 0,
              status: gateway.status,
              startTimestamp: gateway.startTimestamp,
              endTimestamp: gateway.endTimestamp,
              settings: gateway.settings,
              stats: gateway.stats,
              properties: JSON.stringify({
                totalDelegatedStake: gateway.totalDelegatedStake,
                delegates: gateway.delegates ? Object.keys(gateway.delegates).length : 0
              })
            });
          }
        }
        
        cursor = response.nextCursor;
        hasMore = response.hasMore;
      } catch (pageError) {
        console.error(`Error fetching page ${pageCount}:`, pageError);
        // If pagination fails, try to get all at once
        if (pageCount === 1) {
          console.log('Attempting to fetch all gateways without pagination...');
          const allGateways = await ario.getGateways();
          
          // Convert from object format to array
          for (const [address, gateway] of Object.entries(allGateways)) {
            if (gateway.status === 'joined' && gateway.settings?.fqdn) {
              gateways.push({
                fqdn: gateway.settings.fqdn,
                wallet: address,
                stake: gateway.operatorStake || 0,
                status: gateway.status,
                startTimestamp: gateway.startTimestamp,
                endTimestamp: gateway.endTimestamp,
                settings: gateway.settings,
                stats: gateway.stats,
                properties: JSON.stringify({
                  totalDelegatedStake: gateway.totalDelegatedStake,
                  delegates: gateway.delegates ? Object.keys(gateway.delegates).length : 0
                })
              });
            }
          }
          break;
        }
        throw pageError;
      }
    }

    console.log(`\nTotal gateways in network: ${totalFetched}`);
    console.log(`Joined gateways (analyzed): ${gateways.length}`);
    console.log(`Leaving/other: ${totalFetched - gateways.length}`);
    return { gateways, totalFetched };
    
  } catch (error) {
    console.error('Error loading AR.IO SDK:', error);
    throw new Error('Failed to fetch gateways from network. Please ensure @ar.io/sdk is installed.');
  }
}

export async function fetchDistributions(epochIndex?: number): Promise<{ rewards?: Record<string, number>; totalEligibleGatewayReward?: number } | null> {
  try {
    const { ARIO } = await import('@ar.io/sdk');
    const ario = ARIO.mainnet();
    
    console.log('Fetching distribution data...');
    const distributions = await ario.getDistributions(epochIndex ? { epochIndex } : {});
    
    // Log the structure to understand the data
    console.log('Distribution data structure:', {
      hasDistributions: !!distributions,
      keys: distributions ? Object.keys(distributions) : [],
      totalEligibleRewards: distributions?.totalEligibleRewards,
      totalEligibleGatewayReward: distributions?.totalEligibleGatewayReward,
      totalDistributedRewards: distributions?.totalDistributedRewards,
      hasRewards: !!distributions?.rewards,
      rewardsKeys: distributions?.rewards ? Object.keys(distributions.rewards) : []
    });
    
    // Log rewards.eligible structure if it exists
    if (distributions?.rewards?.eligible) {
      const eligible = distributions.rewards.eligible;
      console.log('Eligible rewards structure:', {
        type: typeof eligible,
        isArray: Array.isArray(eligible),
        keys: typeof eligible === 'object' && !Array.isArray(eligible) ? Object.keys(eligible).slice(0, 5) : [],
        entriesCount: typeof eligible === 'object' && !Array.isArray(eligible) ? Object.keys(eligible).length : 0
      });
    }
    
    return distributions;
  } catch (error) {
    console.error('Error fetching distributions:', error);
    return null;
  }
}

export function getDemoGateways(): { gateways: Gateway[], totalFetched: number } {
  console.log('Using demo data (set USE_DEMO_DATA=false to use real network data)');

  const gateways = [
    // Suspicious pattern 1: Sequential numbering on same domain
    { fqdn: 'ar1.innode.tech', wallet: 'wallet1', stake: 10000, status: 'joined', startTimestamp: Date.now() - 86400000 },
    { fqdn: 'ar2.innode.tech', wallet: 'wallet2', stake: 10000, status: 'joined', startTimestamp: Date.now() - 86300000 },
    { fqdn: 'ar3.innode.tech', wallet: 'wallet3', stake: 10000, status: 'joined', startTimestamp: Date.now() - 86200000 },
    { fqdn: 'ar4.innode.tech', wallet: 'wallet4', stake: 10000, status: 'joined', startTimestamp: Date.now() - 86100000 },
    { fqdn: 'ar5.innode.tech', wallet: 'wallet5', stake: 10000, status: 'joined', startTimestamp: Date.now() - 86000000 },
    
    // Suspicious pattern 2: Different sequential pattern
    { fqdn: 'gw1.noddex.com', wallet: 'wallet6', stake: 10000, status: 'joined', startTimestamp: Date.now() - 172800000 },
    { fqdn: 'gw2.noddex.com', wallet: 'wallet7', stake: 10000, status: 'joined', startTimestamp: Date.now() - 172700000 },
    { fqdn: 'gw3.noddex.com', wallet: 'wallet8', stake: 10000, status: 'joined', startTimestamp: Date.now() - 172600000 },
    
    // More patterns
    { fqdn: 'node1.cheaphost.xyz', wallet: 'wallet15', stake: 10000, status: 'joined', startTimestamp: Date.now() - 259200000 },
    { fqdn: 'node2.cheaphost.xyz', wallet: 'wallet16', stake: 10000, status: 'joined', startTimestamp: Date.now() - 259100000 },
    { fqdn: 'node3.cheaphost.xyz', wallet: 'wallet17', stake: 10000, status: 'joined', startTimestamp: Date.now() - 259000000 },
    { fqdn: 'node4.cheaphost.xyz', wallet: 'wallet18', stake: 10000, status: 'joined', startTimestamp: Date.now() - 258900000 },
    
    // Legitimate gateways
    { fqdn: 'gateway.arweave.dev', wallet: 'wallet9', stake: 100000, status: 'joined', startTimestamp: Date.now() - 31536000000 },
    { fqdn: 'permagate.io', wallet: 'wallet10', stake: 500000, status: 'joined', startTimestamp: Date.now() - 15552000000 },
    { fqdn: 'ar-io.dev', wallet: 'wallet11', stake: 250000, status: 'joined', startTimestamp: Date.now() - 7776000000 },
    { fqdn: 'vilenarios.com', wallet: 'wallet12', stake: 150000, status: 'joined', startTimestamp: Date.now() - 5184000000 },
    
    // Edge cases
    { fqdn: 'east.distributed.network', wallet: 'wallet13', stake: 50000, status: 'joined', startTimestamp: Date.now() - 10368000000 },
    { fqdn: 'west.distributed.network', wallet: 'wallet14', stake: 50000, status: 'joined', startTimestamp: Date.now() - 8640000000 },
  ];

  return { gateways, totalFetched: gateways.length };
}