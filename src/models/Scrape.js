import mongoose from 'mongoose';

const scrapeSchema = new mongoose.Schema(
  {
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Profile',
      required: true,
      index: true,
    },
    kind: { type: String, required: true },
    // The "logical" date this row represents (start of period, midnight-aligned).
    reportDate: { type: Date, required: true, index: true },
    // Original Report Date string from the page, for debugging.
    reportDateString: { type: String, default: '' },
    // Parsed numeric/typed fields.
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Original cells keyed by column header, for audit.
    raw: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Every table extracted from the page on this fetch, for future use.
    // Each item: { id, className, headers, rows, rowCount, frameUrl }
    tables: { type: [mongoose.Schema.Types.Mixed], default: [] },
    scrapedAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true },
);

// Index for queries; not unique because zoomwlb appends a new doc per fetch.
// cgaming relies on findOneAndUpdate(upsert) at the application layer.
scrapeSchema.index({ profileId: 1, reportDate: 1 });
scrapeSchema.index({ profileId: 1, scrapedAt: -1 });

export const Scrape = mongoose.model('Scrape', scrapeSchema);
