/**
 * Geographic location and ISP detection utilities
 */

import * as http from 'http';

export interface GeoLocationData {
  status: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  asname?: string;
  hosting?: boolean;
  query?: string;
}

// Cache geo lookups to avoid rate limiting
const geoCache = new Map<string, GeoLocationData>();

// Track rate limiting
let rateLimitHits = 0;
let lastRateLimitReset = Date.now();

// Known hosting providers and data centers
const HOSTING_PROVIDERS = [
  // Major Cloud Providers
  'amazon', 'aws', 'ec2', 'amazon web services', 'amazon technologies',
  'google', 'gcp', 'google cloud', 'google llc',
  'microsoft', 'azure', 'microsoft corporation',
  'alibaba', 'aliyun', 'alibaba cloud',
  'oracle', 'oracle cloud', 'oracle corporation',
  'ibm', 'ibm cloud', 'softlayer',
  
  // Popular VPS/Cloud Providers
  'digitalocean', 'digital ocean',
  'linode', 'akamai', 'akamai technologies',
  'vultr', 'vultr holdings', 'choopa',
  'ovh', 'ovhcloud', 'ovh sas', 'ovh hosting',
  'hetzner', 'hetzner online',
  'scaleway', 'online sas', 'online.net',
  'upcloud', 'upcloud ltd',
  'contabo', 'contabo gmbh',
  'kamatera', 'kamatera inc',
  
  // European Providers
  'ionos', '1&1', '1and1', 'united internet',
  'leaseweb', 'leaseweb usa',
  'netcup', 'netcup gmbh',
  'time4vps', 'interneto vizija',
  'aruba', 'aruba s.p.a',
  'tilaa', 'tilaa bv',
  
  // Budget/Offshore Providers
  'hostinger', 'hostinger international',
  'buyvm', 'frantech',
  'racknerd', 'racknerd llc',
  'virmach', 'virtual machine solutions',
  'nexusbytes', 'nexus bytes',
  'webhostingtalk', 'lowendbox',
  
  // CDN/Edge Providers
  'cloudflare', 'cloudflare inc',
  'fastly', 'fastly inc',
  'bunny', 'bunnycdn', 'bunny.net',
  'stackpath', 'maxcdn',
  'keycdn', 'proinity',
  
  // Dedicated Server Providers
  'rackspace', 'rackspace hosting',
  'liquidweb', 'liquid web',
  'singlehop', 'inap',
  'psychz', 'psychz networks',
  'reliablesite', 'reliable site',
  'wholesaleinternet', 'wholesale internet',
  'dacentec', 'datashack',
  'serverdiscounter', 'server4you',
  
  // Colocation/Data Centers
  'equinix', 'equinix inc',
  'coresite', 'coresite realty',
  'cyrusone', 'cyrus one',
  'digital realty', 'digitalrealty',
  'qts', 'quality technology',
  'flexential', 'peak 10',
  'databank', 'databank holdings',
  
  // Specific Data Center Operators
  'cogent', 'cogent communications',
  'hurricane', 'hurricane electric',
  'level3', 'level 3', 'centurylink', 'lumen',
  'ntt', 'ntt communications',
  'telia', 'telia company',
  'zayo', 'zayo group',
  
  // Generic Terms
  'datacenter', 'data center', 'data-center',
  'colocation', 'colo',
  'dedicated', 'dedi',
  'virtual', 'vps', 'vds',
  'hosting', 'server',
  'cloud', 'compute',
  
  // Additional Specific Providers
  'godaddy', 'godaddy.com',
  'namecheap', 'namecheap inc',
  'bluehost', 'bluehost inc',
  'dreamhost', 'new dream network',
  'siteground', 'siteground hosting',
  'a2hosting', 'a2 hosting',
  'wpengine', 'wp engine',
  'kinsta', 'kinsta inc',
  'flywheel', 'mediaTemple',
  
  // Russian/Eastern European
  'selectel', 'selectel ltd',
  'reg.ru', 'regru',
  'timeweb', 'timeweb cloud',
  'vscale', 'vscale.io',
  
  // Asian Providers
  'sakura', 'sakura internet',
  'conoha', 'gmo internet',
  'bandwagon', 'bandwagonhost',
  'dmit', 'dmit.io',
  
  // Blockchain/Crypto Specific
  'cherryservers', 'cherry servers',
  'latitude', 'latitude.sh',
  'packet', 'packet.com',
  'bare metal', 'baremetal'
];

export async function getGeoLocation(ip: string): Promise<GeoLocationData | null> {
  // Check cache first
  if (geoCache.has(ip)) {
    return geoCache.get(ip)!;
  }
  
  // Skip if we're being rate limited heavily
  if (rateLimitHits > 10) {
    return null;
  }

  // Use ip-api.com free service (100 requests per minute limit)
  // Note: Free tier only supports HTTP, not HTTPS
  const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,query`;

  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';

      // Check status code
      if (res.statusCode !== 200) {
        // Silently fail for non-200 responses
        resolve(null);
        return;
      }

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          // Validate we have data
          if (!data || data.trim().length === 0) {
            resolve(null);
            return;
          }

          const geoData = JSON.parse(data) as GeoLocationData;
          
          if (geoData.status === 'success') {
            // Reset rate limit counter on successful request
            if (Date.now() - lastRateLimitReset > 60000) {
              rateLimitHits = 0;
              lastRateLimitReset = Date.now();
            }
            
            // Detect if it's a hosting provider
            const orgLower = (geoData.org || '').toLowerCase();
            const ispLower = (geoData.isp || '').toLowerCase();
            const asnameLower = (geoData.asname || '').toLowerCase();
            
            geoData.hosting = HOSTING_PROVIDERS.some(provider => 
              orgLower.includes(provider) || 
              ispLower.includes(provider) || 
              asnameLower.includes(provider)
            );
            
            geoCache.set(ip, geoData);
            resolve(geoData);
          } else {
            // Check if we hit rate limit
            if (geoData.message?.includes('rate limit') || geoData.message?.includes('private')) {
              rateLimitHits++;
            }
            // Silently fail for API errors
            resolve(null);
          }
        } catch (_error) {
          // Silently fail for parse errors
          resolve(null);
        }
      });
    });

    req.on('error', (_error) => {
      // Silently fail for network errors
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.setTimeout(5000);
  });
}

// Rate limiting helper - wait between requests
export async function rateLimitDelay(ms: number = 1400): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Get geographic distance between two coordinates in km
export function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI/180);
}

// Identify specific cloud provider from ISP/Org data
export function identifyCloudProvider(isp?: string, org?: string, asname?: string): string | null {
  const checkString = `${isp || ''} ${org || ''} ${asname || ''}`.toLowerCase();
  
  // Check for specific providers
  if (checkString.includes('amazon') || checkString.includes('aws') || checkString.includes('ec2')) {
    return 'AWS';
  }
  if (checkString.includes('google') || checkString.includes('gcp')) {
    return 'Google Cloud';
  }
  if (checkString.includes('microsoft') || checkString.includes('azure')) {
    return 'Azure';
  }
  if (checkString.includes('digitalocean') || checkString.includes('digital ocean')) {
    return 'DigitalOcean';
  }
  if (checkString.includes('hetzner')) {
    return 'Hetzner';
  }
  if (checkString.includes('ovh')) {
    return 'OVH';
  }
  if (checkString.includes('linode') || checkString.includes('akamai')) {
    return 'Linode/Akamai';
  }
  if (checkString.includes('vultr') || checkString.includes('choopa')) {
    return 'Vultr';
  }
  if (checkString.includes('oracle')) {
    return 'Oracle Cloud';
  }
  if (checkString.includes('alibaba') || checkString.includes('aliyun')) {
    return 'Alibaba Cloud';
  }
  if (checkString.includes('contabo')) {
    return 'Contabo';
  }
  if (checkString.includes('scaleway') || checkString.includes('online.net')) {
    return 'Scaleway';
  }
  if (checkString.includes('cloudflare')) {
    return 'Cloudflare';
  }
  
  return null;
}