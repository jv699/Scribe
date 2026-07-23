export interface Campaign {
  name: string;
  description: string;
}

// In-memory store — intentionally no persistence yet. When persistence is
// added, this module is the seam: swap the array for file/db writes and
// nothing else in the app changes.
const campaigns: Campaign[] = [];

export function addCampaign(campaign: Campaign): void {
  campaigns.push(campaign);
}

export function listCampaigns(): readonly Campaign[] {
  return campaigns;
}
