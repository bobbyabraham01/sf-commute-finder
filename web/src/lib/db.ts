import mongoose from 'mongoose'

let isConnected = false

export async function connectToDatabase(): Promise<void> {
  if (isConnected) return

  const mongoUri = process.env.MONGO_URI
  if (!mongoUri) {
    throw new Error('Missing MONGO_URI. Add it to web/.env.local before starting the app.')
  }

  await mongoose.connect(mongoUri)
  isConnected = true
}
