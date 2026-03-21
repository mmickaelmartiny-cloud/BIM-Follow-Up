#!/usr/bin/env node
/**
 * BIM Exchange - Collecte quotidienne des KPIs
 * Recupere les donnees et les ajoute a data/kpi-history.json
 */

const fs = require('fs');
const path = require('path');

const API = {
    vaults: 'https://staking-api.bim.finance/vaults',
    tvl: 'https://staking-api.bim.finance/tvl',
    apy: 'https://staking-api.bim.finance/apy/breakdown',
    investors: 'https://dashboard-api.bim.finance/api/v1/beefy/investor-counts'
};

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'kpi-history.json');

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}

async function collect() {
    console.log(`[${new Date().toISOString()}] Collecte des donnees BIM Exchange...`);

    const [vaults, tvl, apy, investors] = await Promise.all([
        fetchJSON(API.vaults),
        fetchJSON(API.tvl),
        fetchJSON(API.apy),
        fetchJSON(API.investors)
    ]);

    // TVL total et par chain
    const tvlByChain = {};
    let totalTVL = 0;
    for (const [chainId, vaultsTvl] of Object.entries(tvl)) {
        let chainTotal = 0;
        for (const val of Object.values(vaultsTvl)) {
            chainTotal += val;
        }
        tvlByChain[chainId] = chainTotal;
        totalTVL += chainTotal;
    }

    // Vaults actifs
    const activeVaults = vaults.filter(v => v.status === 'active').length;
    const totalVaults = vaults.length;

    // Investisseurs
    let totalInvestors = 0;
    if (investors?.items) {
        for (const item of investors.items) {
            totalInvestors += item.investor_counts?.[0] || 0;
        }
    }

    // APY moyen
    const apyValues = Object.values(apy)
        .map(v => v.totalApy)
        .filter(v => typeof v === 'number' && isFinite(v) && v > 0);
    const avgAPY = apyValues.length > 0
        ? apyValues.reduce((s, v) => s + v, 0) / apyValues.length
        : 0;

    // APY max
    const maxAPY = apyValues.length > 0 ? Math.max(...apyValues) : 0;

    // Top vault par TVL
    const tvlMap = {};
    for (const [, vaultsTvl] of Object.entries(tvl)) {
        for (const [vaultId, val] of Object.entries(vaultsTvl)) {
            tvlMap[vaultId] = (tvlMap[vaultId] || 0) + val;
        }
    }
    const topVaultId = Object.entries(tvlMap).sort((a, b) => b[1] - a[1])[0];
    const topVaultInfo = vaults.find(v => v.id === topVaultId?.[0]);

    // Annualized Revenue
    let totalAnnualRevenue = 0;
    const revenueByChain = {};
    const revenueByPlatform = {};
    for (const v of vaults) {
        const vTvl = tvlMap[v.id] || 0;
        const vApy = apy[v.id]?.totalApy;
        const fee = apy[v.id]?.beefyPerformanceFee || 0;
        if (vTvl > 0 && typeof vApy === 'number' && isFinite(vApy) && vApy > 0 && fee > 0) {
            const rev = vTvl * vApy * fee / (1 - fee);
            totalAnnualRevenue += rev;
            const chain = v.chain || v.network || 'unknown';
            revenueByChain[chain] = (revenueByChain[chain] || 0) + rev;
            revenueByPlatform[v.platformId] = (revenueByPlatform[v.platformId] || 0) + rev;
        }
    }

    // Users par chain/platform
    const usersByChain = {};
    const usersByPlatform = {};
    if (investors?.items) {
        for (const item of investors.items) {
            const vault = vaults.find(v => v.id === item.beefy_id);
            if (vault && item.investor_counts?.[0]) {
                const chain = vault.chain || vault.network || 'unknown';
                usersByChain[chain] = (usersByChain[chain] || 0) + item.investor_counts[0];
                usersByPlatform[vault.platformId] = (usersByPlatform[vault.platformId] || 0) + item.investor_counts[0];
            }
        }
    }

    // TVL par vault (snapshot complet)
    const vaultDetails = vaults.map(v => {
        const vTvl = tvlMap[v.id] || 0;
        const vApy = apy[v.id]?.totalApy;
        const fee = apy[v.id]?.beefyPerformanceFee || 0;
        const validApy = typeof vApy === 'number' && isFinite(vApy) && vApy > 0;
        const annualRevenue = (vTvl > 0 && validApy && fee > 0) ? vTvl * vApy * fee / (1 - fee) : 0;
        return {
        id: v.id,
        name: v.name,
        chain: v.chain || v.network,
        token: v.token,
        platform: v.platformId,
        tvl: vTvl,
        apy: validApy ? vApy : 0,
        annualRevenue,
        status: v.status
    }; }).filter(v => v.tvl > 0 || v.apy > 0);

    const entry = {
        date: new Date().toISOString().split('T')[0],
        timestamp: Date.now(),
        kpis: {
            totalTVL,
            activeVaults,
            totalVaults,
            totalInvestors,
            avgAPY,
            maxAPY,
            totalAnnualRevenue,
            topVault: topVaultInfo ? {
                id: topVaultInfo.id,
                name: topVaultInfo.name,
                chain: topVaultInfo.chain || topVaultInfo.network,
                tvl: topVaultId[1]
            } : null
        },
        tvlByChain,
        revenueByChain,
        revenueByPlatform,
        usersByChain,
        usersByPlatform,
        vaults: vaultDetails
    };

    // Charger l'historique existant ou creer
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }

    // Remplacer l'entree du jour si elle existe deja
    const todayIndex = history.findIndex(h => h.date === entry.date);
    if (todayIndex >= 0) {
        history[todayIndex] = entry;
        console.log(`  -> Entree du ${entry.date} mise a jour.`);
    } else {
        history.push(entry);
        console.log(`  -> Nouvelle entree ajoutee: ${entry.date}`);
    }

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`  -> ${history.length} entree(s) dans l'historique.`);
    console.log(`  -> TVL Total: $${totalTVL.toFixed(2)}`);
    console.log(`  -> Vaults actifs: ${activeVaults}/${totalVaults}`);
    console.log(`  -> Investisseurs: ${totalInvestors}`);
    console.log(`  -> APY moyen: ${(avgAPY * 100).toFixed(2)}%`);
    console.log('[OK] Collecte terminee.');
}

collect().catch(err => {
    console.error('[ERREUR]', err.message);
    process.exit(1);
});
