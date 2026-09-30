/** Odysseus's fictional itinerary candidates; no live trip or remote asset. */
export const rankingJourneys = [
  "Ithaca harbour", "Phaeacian coast", "Circe’s island", "Lotus shore", "Aeolus’s floating island",
  "Ismaros", "Laestrygonian harbour", "Cyclops coast", "Sirens’ passage", "Scylla’s strait",
  "Thrinacia", "Calypso’s island", "Troy’s last evening", "Sparta’s hall", "Pylos at dawn",
].map((label, index) => ({
  id: `journey-${index + 1}`, label,
  detail: index === 4 ? "A sheltered anchorage with a long coastline, an uncertain wind and time to decide the next crossing" : index < 5 ? `Crossing ${index + 1} · shelter and supplies` : undefined,
  link: index === 0 ? "https://example.org/ithaca" : undefined,
}));
