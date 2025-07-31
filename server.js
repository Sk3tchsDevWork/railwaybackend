// Health check endpoint for Railway
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV 
    });
});

// Add at the top after other imports
const PORT = process.env.PORT || 3000;

// Update CORS configuration for Railway
app.use(cors({
    origin: [
        process.env.FRONTEND_URL,
        'http://localhost:3001',
        'http://127.0.0.1:3001'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Update Passport strategies with Railway URL
passport.use(new SteamStrategy({
    returnURL: `${process.env.RAILWAY_STATIC_URL || process.env.BASE_URL}/auth/steam/return`,
    realm: process.env.RAILWAY_STATIC_URL || process.env.BASE_URL,
    apiKey: process.env.STEAM_API_KEY
}, async (identifier, profile, done) => {
    // ... existing Steam strategy code
}));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: `${process.env.RAILWAY_STATIC_URL || process.env.BASE_URL}/auth/discord/callback`,
    scope: ['identify', 'email', 'guilds.join']
}, async (accessToken, refreshToken, profile, done) => {
    // ... existing Discord strategy code
}));

// Add graceful shutdown for Railway
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('✅ Process terminated');
        mongoose.connection.close();
    });
});

// Start server with Railway support
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV}`);
    console.log(`🔗 Railway URL: ${process.env.RAILWAY_STATIC_URL}`);
    console.log(`🎯 Frontend URL: ${process.env.FRONTEND_URL}`);
});
