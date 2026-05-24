// Opens the target character's info window in the active EVE client
async function openFleetBossWindow(characterId, bossCharacterId) {
  try {
    const token = await window.eveAPI.getValidToken(characterId);
    
    await fetch(`https://esi.evetech.net/v1/ui/openwindow/information/?target_id=${bossCharacterId}&datasource=tranquility`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`Command sent to EVE client: Opened info for ${bossCharacterId}`);
  } catch (error) {
    console.error('Failed to trigger EVE UI:', error);
  }
}