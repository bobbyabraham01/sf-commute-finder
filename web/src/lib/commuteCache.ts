import { Schema, model, models } from 'mongoose'

interface LegSummaryDoc {
  walkMinutes: number
  subwayMinutes: number
  railMinutes: number
  busMinutes: number
  ferryMinutes: number
  carMinutes: number
}

interface CommuteCacheDoc {
  workAddress: string
  ntaCode: string
  minutes: number
  legs: LegSummaryDoc
  updatedAt: Date
}

const legSummarySchema = new Schema<LegSummaryDoc>(
  {
    walkMinutes:   { type: Number, default: 0 },
    subwayMinutes: { type: Number, default: 0 },
    railMinutes:   { type: Number, default: 0 },
    busMinutes:    { type: Number, default: 0 },
    ferryMinutes:  { type: Number, default: 0 },
    carMinutes:    { type: Number, default: 0 },
  },
  { _id: false }
)

const commuteCacheSchema = new Schema<CommuteCacheDoc>(
  {
    workAddress: { type: String, required: true, index: true },
    ntaCode: { type: String, required: true, index: true },
    minutes: { type: Number, required: true },
    legs: { type: legSummarySchema, required: true },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false }
)

commuteCacheSchema.index({ workAddress: 1, ntaCode: 1 }, { unique: true })

export const CommuteCache =
  models.CommuteCache || model<CommuteCacheDoc>('CommuteCache', commuteCacheSchema)
