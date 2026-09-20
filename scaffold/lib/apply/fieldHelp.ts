/**
 * Plain-English help for each SF-424 field shown on the assembled package —
 * what it is and where to find it — surfaced as an "ⓘ" tooltip next to the
 * label. Keyed by the field `key` produced in lib/apply/forms.ts. A key with no
 * entry simply shows no tooltip.
 */
export const FIELD_HELP: Record<string, string> = {
  uei: "Your organization's 12-character Unique Entity Identifier. Find it on your SAM.gov entity registration.",
  sam_registered: "Whether your organization has an active SAM.gov registration. Check or start it at SAM.gov (it can take ~2 weeks to become Active).",
  entity_type: "Your applicant/organization type (e.g. small business, nonprofit). It's set on your SAM.gov registration.",
  naics_code: "The NAICS industry code(s) for your work. Look them up at census.gov/naics.",
  authorized_representative_name: "The person SAM.gov lists as authorized to submit for your organization (your AOR). Find it under your SAM.gov roles.",
  awarding_agency: "The federal agency running this program — filled from the opportunity listing.",
  funding_opportunity_title: "The program's official title — filled from the opportunity listing.",
  funding_opportunity_number: "The program's official opportunity/announcement number — on the listing (e.g. grants.gov or SAM.gov).",
  applicant_location: "Your organization's location, as you described it.",
  project_title: "A short title for YOUR proposed project — not the program's name. You write this.",
  organization_name: "Your organization's legal name, exactly as registered in SAM.gov.",
  applicant_street: "Your organization's street address, as registered in SAM.gov.",
  applicant_city: "Your organization's city, as registered in SAM.gov.",
  applicant_state: "Your organization's state, as registered in SAM.gov.",
  applicant_zip: "Your organization's ZIP / postal code, as registered in SAM.gov.",
  applicant_congressional_district: "Your U.S. congressional district (e.g. ID-01). Look it up at house.gov — Find Your Representative.",
  federal_funding_requested: "The exact federal dollar amount you're requesting. Set this from your budget.",
  total_project_cost: "The exact total cost of your project (federal request plus any cost-share/match). Set this from your budget.",
  project_start_date: "Your proposed project START date — not a program deadline. You choose this.",
  project_end_date: "Your proposed project END date. You choose this.",
};
