export default async function handler(req, res) {
    try {
        const response = await fetch('https://vaults-timeline.bim.finance/api/v2/tvlByChains?bucket=1d_1Y');
        const data = await response.json();
        res.setHeader('Cache-Control', 's-maxage=300');
        res.status(200).json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}
