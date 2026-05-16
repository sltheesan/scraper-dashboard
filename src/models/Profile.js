import mongoose from 'mongoose';

export const PROFILE_STATUSES = [
  'idle',
  'logged_in',
  'scraping',
  'logged_out',
  'error',
];

export const PROFILE_KINDS = ['cgaming', 'zoomwlb'];

const dataFieldSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const profileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    kind: { type: String, enum: PROFILE_KINDS, default: 'cgaming', required: true },
    loginUrl: { type: String, required: true, trim: true },
    targetUrl: { type: String, required: true, trim: true },
    refreshIntervalMs: { type: Number, default: 300000, min: 10000 },
    buttonSelector: { type: String, default: '', trim: true },
    dataFields: { type: [dataFieldSchema], default: [] },
    status: { type: String, enum: PROFILE_STATUSES, default: 'idle' },
    lastLoginAt: { type: Date, default: null },
    lastScrapeAt: { type: Date, default: null },
    userDataDir: { type: String, default: '' },
    proxy: { type: String, default: '', trim: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

export const Profile = mongoose.model('Profile', profileSchema);
