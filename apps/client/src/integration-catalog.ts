export const INTEGRATION_CATEGORIES = ['All', 'Analytics', 'Communication', 'Social Media', 'Publishing', 'MCP'] as const;
export type IntegrationCategory = typeof INTEGRATION_CATEGORIES[number];
export type Integration = {
  id: string;
  name: string;
  category: Exclude<IntegrationCategory, 'All'>;
  description: string;
  keywords: string;
  tint: string;
};

// The same channel and integration catalog as iGEO's current agents screens.
// Catalog presence does not imply that a provider is connected in Citevia.
export const INTEGRATIONS: Integration[] = [
  { id: 'google', name: 'Google', category: 'Analytics', description: 'Bring your Search Console and Google Analytics data into one place.', keywords: 'search console analytics GA4', tint: '#dbebfe' },
  { id: 'bing', name: 'Bing Webmaster Tools', category: 'Analytics', description: 'Understand how your website performs in Bing search.', keywords: 'microsoft webmaster search', tint: '#dbebfe' },
  { id: 'cloudflare', name: 'Cloudflare', category: 'Analytics', description: 'See how AI crawlers discover and explore your website.', keywords: 'AI crawlers CDN traffic', tint: '#fcebda' },
  { id: 'slack', name: 'Slack', category: 'Communication', description: 'Keep your team in the loop with updates in your Slack workspace.', keywords: 'workflow notifications team', tint: '#f0ecfb' },
  { id: 'facebook', name: 'Facebook', category: 'Social Media', description: 'Connect your Facebook page to publish content with Citevia agents.', keywords: 'meta social posts', tint: '#dbebfe' },
  { id: 'instagram', name: 'Instagram', category: 'Social Media', description: 'Connect your Instagram account to share content with your audience.', keywords: 'meta social posts', tint: '#f7e0e6' },
  { id: 'linkedin', name: 'LinkedIn', category: 'Social Media', description: 'Connect your LinkedIn account to share your expertise.', keywords: 'professional social posts', tint: '#dbebfe' },
  { id: 'x', name: 'X (Twitter)', category: 'Social Media', description: 'Connect your X account to bring your brand into the conversation.', keywords: 'twitter social posts', tint: '#f2f2f0' },
  { id: 'pinterest', name: 'Pinterest', category: 'Social Media', description: 'Connect your Pinterest boards to publish content that gets discovered.', keywords: 'pins boards social', tint: '#f7e0e6' },
  { id: 'reddit', name: 'Reddit', category: 'Social Media', description: 'Connect your Reddit account to contribute to relevant communities.', keywords: 'subreddit community social', tint: '#fcebda' },
  { id: 'blog', name: 'Blog', category: 'Publishing', description: 'Connect your WordPress website to publish articles from Citevia.', keywords: 'wordpress website publishing articles', tint: '#f1f9e3' },
  { id: 'cursor', name: 'Cursor', category: 'MCP', description: 'Explore your prompts, visibility, and competitors from your editor.', keywords: 'IDE AI code editor MCP', tint: '#f2f2f0' },
  { id: 'claude', name: 'Claude', category: 'MCP', description: 'Give Claude access to your Citevia insights and account tools.', keywords: 'anthropic AI assistant MCP', tint: '#fcebda' },
  { id: 'sheets', name: 'Google Sheets', category: 'MCP', description: 'Use an MCP-enabled workflow to bring Citevia insights into spreadsheets.', keywords: 'spreadsheet reports MCP', tint: '#f1f9e3' },
  { id: 'lovable', name: 'Lovable', category: 'MCP', description: 'Use Citevia data in your AI app-building workflow through MCP.', keywords: 'AI app builder MCP', tint: '#f7e0e6' },
  { id: 'chatgpt', name: 'ChatGPT', category: 'MCP', description: 'Explore your brand’s AI visibility directly from ChatGPT.', keywords: 'openai AI assistant MCP', tint: '#f2f2f0' },
  { id: 'n8n', name: 'n8n', category: 'MCP', description: 'Build automation workflows with your Citevia data and MCP tools.', keywords: 'automation workflow MCP', tint: '#fcebda' },
];

export const AGENT_CHANNELS = ['facebook', 'instagram', 'x', 'pinterest', 'reddit', 'blog'] as const;
export const AGENTS = AGENT_CHANNELS.map(id => INTEGRATIONS.find(item => item.id === id)!);

export function filterIntegrations(category: IntegrationCategory, search: string) {
  const needle = search.trim().toLocaleLowerCase();
  return INTEGRATIONS.filter(item =>
    (category === 'All' || item.category === category) &&
    `${item.name} ${item.category} ${item.keywords}`.toLocaleLowerCase().includes(needle),
  );
}
