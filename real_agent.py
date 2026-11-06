import asyncio
from google.antigravity import Agent, LocalOpenAIAgentConfig, CapabilitiesConfig

def calculate(expression: str) -> str:
    """Calculate math"""
    if not all(c in "0123456789+-*/(). " for c in expression):
        return "Only numbers allowed"
    return str(eval(expression))

def get_text(res):
    # Try all real fields wey Antigravity SDK dey return
    for attr in ["text", "content", "output_text", "response"]:
        if hasattr(res, attr):
            v = getattr(res, attr)
            if isinstance(v, str) and v.strip():
                return v
    # Try message -> content
    try:
        m = res.message
        if isinstance(m, str):
            return m
        if hasattr(m, "content"):
            c = m.content
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return "".join([p.text if hasattr(p, "text") else str(p) for p in c])
    except: pass
    # Last fallback - show full object
    return str(res)

async def main():
    print("Connecting REAL Antigravity to Bun...")
    config = LocalOpenAIAgentConfig(
        base_url="http://localhost:3000/v1",
        model="pollinations-agent",
        system_instructions="You are a helpful agent. Use tools when needed.",
        tools=[calculate],
        capabilities=CapabilitiesConfig(),
    )
    async with Agent(config) as agent:
        print("AGENT STARTED - REAL SDK")
        r = await agent.chat("What is 10*5+2 and the weather in Lagos?")
        print("ANSWER FROM REAL ANTIGRAVITY:")
        print(get_text(r))
        print("\n--- RAW TYPE ---")
        print(type(r))
        print([x for x in dir(r) if not x.startswith("_")])

asyncio.run(main())
