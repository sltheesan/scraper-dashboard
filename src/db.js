import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUrl, {
    serverSelectionTimeoutMS: 10000,
  });
  return mongoose.connection;
}
