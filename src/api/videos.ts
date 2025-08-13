import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { randomBytes } from "crypto";
import path from "path";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

async function getVideoAspectRatio(filePath: string): Promise<string> {
  // Use Bun.spawn to run ffprobe command
  const proc = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    filePath
  ], {
    stdout: "pipe",
    stderr: "pipe"
  });

  // Read the contents of stdout and stderr
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  
  // Wait for the process to exit and check the result
  const exitCode = await proc.exited;
  
  if (exitCode !== 0) {
    console.error("ffprobe error:", stderr);
    throw new Error(`ffprobe failed with exit code ${exitCode}: ${stderr}`);
  }

  try {
    // Parse the stdout to get width and height
    const result = JSON.parse(stdout);
    const stream = result.streams?.[0];
    
    if (!stream || !stream.width || !stream.height) {
      throw new Error("Could not extract width and height from video");
    }

    const width = parseInt(stream.width);
    const height = parseInt(stream.height);
    
    // Calculate aspect ratio and determine orientation
    const aspectRatio = width / height;
    
    // Use tolerance for common aspect ratios
    // 16:9 ≈ 1.78, 9:16 ≈ 0.56
    if (Math.abs(aspectRatio - 16/9) < 0.1) {
      return "landscape";
    } else if (Math.abs(aspectRatio - 9/16) < 0.1) {
      return "portrait";
    } else {
      return "other";
    }
  } catch (error) {
    console.error("Error parsing ffprobe output:", error);
    throw new Error("Failed to parse video metadata");
  }
}

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  // Set upload limit of 1 GB
  const MAX_UPLOAD_SIZE = 1 << 30; // 1 GB = 1073741824 bytes

  // Extract videoID from URL path parameters and parse as UUID
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  // Authenticate the user to get userID
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video for video", videoId, "by user", userID);

  // Get the video metadata from the database
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  }

  // Check if the user is the video owner
  if (video.userID !== userID) {
    throw new UserForbiddenError("User is not authorized to upload video for this video");
  }

  // Parse the uploaded video file from the form data
  const formData = await req.formData();
  const videoFile = formData.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Invalid file upload");
  }

  // Check that file size does not exceed upload limit
  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 1GB limit");
  }

  // Validate the uploaded file to ensure it's an MP4 video
  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Only MP4 video format is allowed");
  }

  // Generate random filename using 32 random bytes converted to hex
  const randomBuffer = randomBytes(32);
  const randomFileName = randomBuffer.toString("hex");
  const fileName = `${randomFileName}.mp4`;

  // Save the uploaded file to a temporary file on disk
  const tempFilePath = path.join("/tmp", fileName);
  
  try {
    // Write the file to temporary location
    await Bun.write(tempFilePath, videoFile);

    // Get the aspect ratio of the video file
    const aspectRatio = await getVideoAspectRatio(tempFilePath);
    
    // Add aspect ratio as path prefix (folder structure)
    const keyWithPrefix = `${aspectRatio}/${fileName}`;

    // Put the object into S3
    const s3File = cfg.s3Client.file(keyWithPrefix);
    await s3File.write(Bun.file(tempFilePath), {
      type: "video/mp4"
    });

    // Update the VideoURL of the video record in the database with S3 URL
    // Note: Switch to CloudFront URL once S3_CF_DISTRO is properly configured
    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${keyWithPrefix}`;
    
    const updatedVideo = {
      ...video,
      videoURL,
    };

    // Update the video in the database
    updateVideo(cfg.db, updatedVideo);

    // Return the updated video metadata
    return respondWithJSON(200, updatedVideo);
  } finally {
    // Remove the temporary file
    try {
      const fs = await import("fs/promises");
      await fs.unlink(tempFilePath);
    } catch (error) {
      console.warn("Failed to clean up temporary file:", error);
    }
  }
}
