"use server"

import { onCurrentUser } from "@/actions/user"
import { client } from "@/lib/prisma"
import { revalidatePath } from "next/cache"

export async function getUserReferralData() {
  const user = await onCurrentUser()

  if (!user) {
    throw new Error("Unauthorized")
  }

  // Find the user in our database
  const dbUser = await client.user.findUnique({
    where: { clerkId: user.id },
    select: { id: true },
  })

  if (!dbUser) {
    throw new Error("User not found in database")
  }

  // Get the user's referral code
  const referralCodeData = await client.referralCode.findFirst({
    where: { userId: dbUser.id, active: true },
    include: {
      program: true,
    },
  })

  // If user doesn't have a referral code yet, create one
  if (!referralCodeData) {
    // Find the default referral program
    const defaultProgram = await client.referralProgram.findFirst({
      where: { active: true },
    })

    if (!defaultProgram) {
      // Create a default program if none exists
      const newProgram = await client.referralProgram.create({
        data: {
          name: "Default Referral Program",
          description: "Refer friends and earn rewards",
          commissionType: "PERCENTAGE",
          commissionValue: 10, // 10% commission
          minimumPayout: 10, // $10 minimum payout
          active: true,
        },
      })

      // Create a referral code for the user
      const code = generateReferralCode(user.username || user.firstName || user.id)

      const newReferralCode = await client.referralCode.create({
        data: {
          code,
          userId: dbUser.id,
          programId: newProgram.id,
          active: true,
        },
        include: {
          program: true,
        },
      })

      return {
        referralCode: newReferralCode.code,
        program: newReferralCode.program,
        clicks: 0,
        conversions: 0,
        conversionRate: 0,
        totalCommission: 0,
        availableCommission: 0,
        referrals: [],
        payouts: [],
      }
    }

    // Create a referral code for the user
    const code = generateReferralCode(user.username || user.firstName || user.id)

    const newReferralCode = await client.referralCode.create({
      data: {
        code,
        userId: dbUser.id,
        programId: defaultProgram.id,
        active: true,
      },
      include: {
        program: true,
      },
    })

    return {
      referralCode: newReferralCode.code,
      program: newReferralCode.program,
      clicks: 0,
      conversions: 0,
      conversionRate: 0,
      totalCommission: 0,
      availableCommission: 0,
      referrals: [],
      payouts: [],
    }
  }

  // Get user's referrals
  const referrals = await client.referral.findMany({
    where: {
      referrerId: dbUser.id,
      referralCodeId: referralCodeData.id,
    },
    include: {
      referredUser: {
        select: {
          email: true,
          firstname: true,
          lastname: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  })

  // Get user's commission payouts
  const payouts = await client.commissionPayout.findMany({
    where: { userId: dbUser.id },
    orderBy: { createdAt: "desc" },
  })

  // Calculate total commission
  const totalCommission = referrals.reduce((sum, referral) => {
    return sum + (referral.commissionAmount || 0)
  }, 0)

  // Calculate available commission (not yet paid out)
  const availableCommission = referrals.reduce((sum, referral) => {
    if (referral.status === "CONVERTED" && !referral.commissionPaid) {
      return sum + (referral.commissionAmount || 0)
    }
    return sum
  }, 0)

  return {
    referralCode: referralCodeData.code,
    program: referralCodeData.program,
    clicks: referralCodeData.clicks,
    conversions: referralCodeData.conversions,
    conversionRate: referralCodeData.clicks > 0 ? referralCodeData.conversions / referralCodeData.clicks : 0,
    totalCommission,
    availableCommission,
    referrals,
    payouts,
  }
}

export async function trackReferralClick(code: string, ipAddress?: string, userAgent?: string) {
  // Find the referral code
  const referralCode = await client.referralCode.findUnique({
    where: { code },
  })

  if (!referralCode || !referralCode.active) {
    return false
  }

  // Record the click
  await client.referralClick.create({
    data: {
      referralCodeId: referralCode.id,
      ipAddress,
      userAgent,
    },
  })

  // Update the click count
  await client.referralCode.update({
    where: { id: referralCode.id },
    data: { clicks: { increment: 1 } },
  })

  return true
}

export async function processReferral(referralCode: string, userId: string) {
  // Find the referral code
  const referralCodeData = await client.referralCode.findUnique({
    where: { code: referralCode },
    include: { program: true },
  })

  if (!referralCodeData || !referralCodeData.active) {
    return false
  }

  // Check if this user was already referred
  const existingReferral = await client.referral.findFirst({
    where: {
      referredUserId: userId,
      programId: referralCodeData.programId,
    },
  })

  if (existingReferral) {
    return false // User was already referred
  }

  // Create the referral
  const referral = await client.referral.create({
    data: {
      referrerId: referralCodeData.userId,
      referredUserId: userId,
      referralCodeId: referralCodeData.id,
      programId: referralCodeData.programId,
      status: "PENDING",
    },
  })

  return true
}

export async function convertReferral(referralId: string) {
  // Find the referral
  const referral = await client.referral.findUnique({
    where: { id: referralId },
    include: {
      program: true,
      referralCode: true,
    },
  })

  if (!referral || referral.status !== "PENDING") {
    return false
  }

  // Calculate commission amount
  let commissionAmount = 0
  if (referral.program.commissionType === "PERCENTAGE") {
    // In a real app, you would calculate this based on the purchase amount
    // For this example, we'll use a fixed amount of $100 as the base
    const baseAmount = 100
    commissionAmount = baseAmount * (referral.program.commissionValue / 100)
  } else {
    commissionAmount = referral.program.commissionValue
  }

  // Update the referral
  await client.referral.update({
    where: { id: referral.id },
    data: {
      status: "CONVERTED",
      commissionAmount,
      conversionDate: new Date(),
    },
  })

  // Update the referral code stats
  await client.referralCode.update({
    where: { id: referral.referralCodeId },
    data: {
      conversions: { increment: 1 },
      totalCommission: { increment: commissionAmount },
    },
  })

  revalidatePath("/dashboard/referrals")
  return true
}

export async function requestPayout(userId: string) {
  // Find the user
  const user = await client.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    throw new Error("User not found")
  }

  // Get all converted, unpaid referrals
  const referrals = await client.referral.findMany({
    where: {
      referrerId: userId,
      status: "CONVERTED",
      commissionPaid: false,
    },
    include: {
      program: true,
    },
  })

  if (referrals.length === 0) {
    throw new Error("No commissions available for payout")
  }

  // Calculate total amount
  const totalAmount = referrals.reduce((sum, referral) => {
    return sum + (referral.commissionAmount || 0)
  }, 0)

  // Check minimum payout
  const minPayout = referrals[0].program.minimumPayout
  if (totalAmount < minPayout) {
    throw new Error(`Minimum payout amount is $${minPayout}`)
  }

  // Create payout
  const payout = await client.commissionPayout.create({
    data: {
      userId,
      programId: referrals[0].programId,
      amount: totalAmount,
      status: "PENDING",
      paymentMethod: "BANK_TRANSFER",
    },
  })

  // Update referrals
  await Promise.all(
    referrals.map((referral) =>
      client.referral.update({
        where: { id: referral.id },
        data: {
          commissionPaid: true,
          commissionPayoutId: payout.id,
        },
      }),
    ),
  )

  revalidatePath("/dashboard/referrals")
  return payout
}

function generateReferralCode(seed: string) {
  // Generate a unique referral code based on the user's info
  const prefix = seed.substring(0, 4).toUpperCase()
  const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase()
  return `${prefix}-${randomPart}`
}
